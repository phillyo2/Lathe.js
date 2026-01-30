import React, { useEffect, useRef, useState } from 'react';

/**
 * Lathe.js_V0.0461 // AUTO_DEDUPLICATION
 * * ENGINE UPDATE:
 * - Added `deduplicate` (bool) to ACTORS config.
 * - In `init()`, if this flag is true, the engine creates a temporary analysis buffer.
 * - It performs a pixel-perfect comparison (memcmp style) between adjacent frames in the animation lists.
 * - Duplicate frames (pauses) are stripped out automatically at runtime.
 * * MUMMY UPDATE:
 * - Enabled `deduplicate: true`.
 * - This smooths the walk cycle by removing the "stutter" frames inherent in the original sprite sheet.
 */

const App = () => {
  const canvasRef = useRef(null);
  const [activeActor, setActiveActor] = useState('dude');
  const [debugView, setDebugView] = useState(false);
  
  const REG = {
    TICK: 0, CAM_X: 1, CAM_Y: 2, ZOOM: 3,
    PX: 10, PY: 11, PH_ROT: 12, PB_ROT: 13, P_PITCH: 14, P_CLOCK: 15,
    P_VEL: 30, P_YVEL: 31, P_GND_Y: 32, P_LAST_LATERAL_DIR: 33,
    P_SWIPE_START_Y: 34, P_IS_SWIPING: 35,
    P_LATCH_SX_BODY: 37, P_LATCH_SX_HEAD: 38,
    P_JUMP_SX_BODY: 39, P_JUMP_SX_HEAD: 40,
    P_ACTIVE_ACTOR: 41,
    P_INITIAL_SYNC: 42,
    P_JUMP_START_TIME: 43,
    P_IS_TOUCHING: 44,
    P_LATCH_ROT_AIR: 45,
    P_LATCH_PITCH_AIR: 46
  };

  const ramRef = useRef(new Float32Array(512));

  // --- CONFIGURATION & LOGIC LAYER ---
  const ACTORS = {
    dude: { 
      url: 'https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/sprites/dude.png',
      w: 32, h: 48, neckY: 34, 
      msWalk: 600, msRun: 300, 
      anims: { WALK_L: [0,1,2,3], WALK_R: [5,6,7,8], IDLE: [4] },
      deduplicate: false, // Dude is already optimized
      // 1. PHYSICS SCALARS
      bobAmplitude: -5.0,
      widthScalar: 1.0,
      slideScale: 0.4,
      rMult: { HEAD: 0.38, BODY: 0.38 },
      // 2. HEAD OFFSET & TRIM
      headSink: { idle: 5.0, profile: 5.0 }, 
      shave: { idle: 0, profile: 1 }, 
      noProfileHeadBob: true, 
      // 3. LOGIC REFERENCES
      getProfileCondition: (isMoving, isRunning) => isRunning,
      shouldFlip: (rot) => false, 
      // 4. ANIMATION LOOKUP
      animMode: 'directional', 
      getAnimKey: (rot) => rot > 0 ? 'WALK_R' : 'WALK_L'
    },
    mummy: {
      url: 'https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/sprites/metalslug_mummy37x45.png',
      w: 37, h: 45, neckY: 26, 
      msWalk: 250, msRun: 120, 
      anims: { WALK: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17], IDLE: [0] },
      deduplicate: true, // * ENABLED: Removes duplicate frames for smooth motion
      // 1. PHYSICS SCALARS
      bobAmplitude: 0.0,
      widthScalar: 0.88,
      slideScale: 0.8,
      rMult: { HEAD: 0.42, BODY: 0.40 },
      // 2. HEAD OFFSET & TRIM
      headSink: { idle: 5.0, profile: 4.0 },
      shave: { idle: 0, profile: 0 },
      noProfileHeadBob: false,
      // 3. LOGIC REFERENCES
      getProfileCondition: (isMoving, isRunning) => isMoving,
      shouldFlip: (rot) => rot < 0, 
      // 4. ANIMATION LOOKUP
      animMode: 'pingpong', 
      getAnimKey: (rot) => 'WALK'
    }
  };

  useEffect(() => {
    const RAM = ramRef.current;
    RAM[REG.P_ACTIVE_ACTOR] = activeActor === 'dude' ? 0 : 1;
    RAM[REG.PH_ROT] = 0; RAM[REG.PB_ROT] = 0; RAM[REG.P_PITCH] = 0; RAM[REG.P_INITIAL_SYNC] = 0; 
  }, [activeActor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const RAM = ramRef.current;

    let loaded = false;
    const pointer = { x: 0, y: 0 };
    const bitmaps = {};
    const SSAA = 2.5; 
    
    // Render Buffer
    const renderBuffer = document.createElement('canvas');
    renderBuffer.width = 400 * SSAA; renderBuffer.height = 400 * SSAA;
    const rbufCtx = renderBuffer.getContext('2d');
    rbufCtx.imageSmoothingEnabled = false; 

    // Analysis Buffer (for deduplication)
    const analysisBuffer = document.createElement('canvas');
    const aCtx = analysisBuffer.getContext('2d');

    async function init() {
      for (const key in ACTORS) {
        const config = ACTORS[key];
        const img = new Image(); img.crossOrigin = "anonymous"; img.src = config.url;
        await new Promise(r => img.onload = r);
        const bmp = await createImageBitmap(img);
        bitmaps[key] = bmp;

        // --- AUTO-DEDUPLICATION LOGIC ---
        if (config.deduplicate) {
           analysisBuffer.width = config.w;
           analysisBuffer.height = config.h;
           
           for (const animName in config.anims) {
               const originalFrames = config.anims[animName];
               const uniqueFrames = [];
               let lastData = null;

               for (let i = 0; i < originalFrames.length; i++) {
                   const frameIdx = originalFrames[i];
                   
                   // Draw frame to analysis buffer
                   aCtx.clearRect(0, 0, config.w, config.h);
                   aCtx.drawImage(bmp, frameIdx * config.w, 0, config.w, config.h, 0, 0, config.w, config.h);
                   
                   const currentData = aCtx.getImageData(0, 0, config.w, config.h).data;
                   
                   let isDuplicate = false;
                   if (lastData) {
                       // Fast pixel comparison
                       isDuplicate = true;
                       for (let p = 0; p < currentData.length; p++) {
                           if (currentData[p] !== lastData[p]) {
                               isDuplicate = false;
                               break;
                           }
                       }
                   }

                   if (!isDuplicate) {
                       uniqueFrames.push(frameIdx);
                       lastData = currentData;
                   }
               }
               // Update the config in memory with the cleaned list
               config.anims[animName] = uniqueFrames;
           }
        }
      }
      RAM[REG.ZOOM] = 2.8; RAM[REG.P_GND_Y] = 0; loaded = true;
    }

    const drawPuppet = (targetCtx, x, y, time, bRot, hRot, pitch, type) => {
      const config = ACTORS[type];
      const bitmap = bitmaps[type];
      if (!bitmap) return;

      rbufCtx.clearRect(0, 0, renderBuffer.width, renderBuffer.height);
      const cx = 200 * SSAA, cy = 200 * SSAA;
      const arc = Math.PI * 0.75; 

      const isAirborne = RAM[REG.PY] < RAM[REG.P_GND_Y];
      
      const sprintThreshold = 42.0; 
      const kineticThreshold = 22.0; 
      const rotMax = 60.0; 
      
      const clampedBRot = Math.max(-rotMax, Math.min(rotMax, bRot));
      const clampedHRot = Math.max(-rotMax, Math.min(rotMax, hRot));

      const absRot = Math.abs(hRot);
      const isRunning = absRot > sprintThreshold;
      const isMoving = absRot > kineticThreshold;

      // SPEED RAMP
      let currentMS = isRunning ? config.msRun : config.msWalk;

      // LATERAL TRACKING
      if (bRot > 2) RAM[REG.P_LAST_LATERAL_DIR] = 1;
      else if (bRot < -2) RAM[REG.P_LAST_LATERAL_DIR] = -1;
      
      let bodyIdx = 0;

      // --- GENERIC ANIMATION RESOLVER ---
      const getSX = (isHeadPart) => {
        const lastSX = isHeadPart ? RAM[REG.P_LATCH_SX_HEAD] : RAM[REG.P_LATCH_SX_BODY];
        const rotVal = isHeadPart ? hRot : bRot;
        let sx = 0;
        
        const isProfileActive = config.getProfileCondition(isMoving, isRunning);
        const shouldAnimate = isAirborne || (isHeadPart ? isProfileActive : isMoving);
        
        if (shouldAnimate) {
            // Determine Timing
            let animTime = time;
            if (isAirborne) animTime = time - RAM[REG.P_JUMP_START_TIME];
            
            // Resolve Sequence Key (e.g., 'WALK_R' vs 'WALK')
            let seqKey = 'IDLE';
            if (isAirborne || isMoving || (isHeadPart && isProfileActive)) {
                // Use the Config function to get key based on rotation
                const dirRef = isAirborne 
                    ? (RAM[REG.P_LAST_LATERAL_DIR] === -1 ? -1 : 1) 
                    : rotVal;
                seqKey = config.getAnimKey(dirRef); 
            }
            
            const seq = config.anims[seqKey] || config.anims['IDLE'];
            
            // Calculate Frame Index based on Mode
            let idx = 0;
            if (config.animMode === 'pingpong') {
                // MUMMY STYLE: Ping Pong Loop
                const L = seq.length; 
                const totalCycleFrames = (L * 2) - 2; 
                const rawIdx = Math.floor(animTime / currentMS);
                const cycleIdx = rawIdx % totalCycleFrames;
                let pingPongIdx = cycleIdx; 
                if (cycleIdx >= L) pingPongIdx = totalCycleFrames - cycleIdx;
                idx = Math.max(0, Math.min(pingPongIdx, L - 1));
            } else {
                // DUDE STYLE: Standard Loop
                idx = Math.floor(animTime / currentMS) % seq.length;
            }

            sx = seq[idx] * config.w;
            if (!isHeadPart) bodyIdx = idx;
        } else {
            sx = config.anims['IDLE'][0] * config.w;
        }

        // Validity Check & Latching
        if (!isNaN(sx) && sx >= 0 && sx + config.w <= bitmap.width) {
            if (isHeadPart) RAM[REG.P_LATCH_SX_HEAD] = sx; else RAM[REG.P_LATCH_SX_BODY] = sx;
            if (!isAirborne) { if (isHeadPart) RAM[REG.P_JUMP_SX_HEAD] = sx; else RAM[REG.P_JUMP_SX_BODY] = sx; }
        } else sx = lastSX; 
        return sx;
      };

      const bSX = getSX(false), hSX = getSX(true);
      const isIdle = !isAirborne && !isMoving;
      const headBounce = Math.sin(time * 0.002) * 1.5;
      
      // 4. DATA-DRIVEN BOBBING
      let movementBob = (bodyIdx % 2 === 1) ? config.bobAmplitude : 0;

      const jumpOffset = RAM[REG.PY] * SSAA;
      
      // 5. DATA-DRIVEN FLIP LOGIC
      const isFlipped = config.shouldFlip(hRot);
      
      const baseBodyH = config.h * (0.94) * 4.2 * SSAA; 
      const bodyNeckAnchor = cy - (baseBodyH / 2) + (config.neckY / config.h) * baseBodyH + jumpOffset;
      
      // 6. DATA-DRIVEN SLIDE AMOUNT
      const slideAmount = -Math.sin(hRot * (Math.PI / 180)) * config.slideScale * SSAA; 

      const renderPass = (layerType, scale, rotationDeg, pitchVal) => {
        const isHeadPart = layerType !== 'BODY';
        const curSX = isHeadPart ? hSX : bSX;

        // 7. DATA-DRIVEN PROFILE CHECK
        const isProfile = config.getProfileCondition(isMoving, isRunning);
        if (isProfile) {
            const CORRECTION = 22.0; 
            rotationDeg = rotationDeg - (Math.sign(rotationDeg) * CORRECTION);
        }

        // --- LAYER CONFIG ---
        let centerX = cx + slideAmount; 
        let verticalOffset = 0;

        // 8. DATA-DRIVEN RADIUS MULTIPLIERS
        const rMult = config.rMult[layerType];

        if (layerType === 'BODY') pitchVal = 0; 
        
        const effectiveRadius = rMult * config.widthScalar;
        let pScale = pitchVal;
        if (isHeadPart && pitchVal > 0) pScale = -pitchVal * 0.3; 
        
        const useSmartStrip = (layerType === 'BODY') || (Math.abs(pitchVal) < 0.1);
        const baseH = config.h * (0.94) * 4.2 * SSAA; 
        const currentH = baseH * scale; 
        const scaledNeckH = (config.neckY / config.h) * currentH;
        let dyBase;
        
        // --- BOUNCE RESOLUTION ---
        let layerBounce = (isIdle) ? headBounce : (!isAirborne && isMoving ? movementBob : 0);
        
        // SUPPRESS HEAD BOB IN PROFILE IF CONFIGURED
        if (isHeadPart && isProfile && config.noProfileHeadBob) {
             if (!isAirborne && isMoving) layerBounce = 0;
        }
        const snapBounce = Math.floor(layerBounce * SSAA);

        if (isHeadPart) {
            let pitchSink = 0;
            if (pitchVal < 0) {
               pitchSink = Math.abs(pitchVal) * 8.0 * SSAA;
            }
            // 9. DATA-DRIVEN HEAD SINK
            const baseSink = isProfile ? config.headSink.profile : config.headSink.idle;
            dyBase = (bodyNeckAnchor + verticalOffset + (baseSink * SSAA) + pitchSink) - scaledNeckH + snapBounce;
        } else {
            dyBase = cy - (baseH / 2) + jumpOffset;
        }
        
        const yStart = isHeadPart ? 0 : config.neckY;
        let yEnd = isHeadPart ? config.neckY : config.h;
        
        // 10. DATA-DRIVEN SHAVE (Trim bottom pixels)
        const shaveAmt = isProfile ? config.shave.profile : config.shave.idle;
        if (isHeadPart) {
            yEnd -= shaveAmt;
        }
        
        const radConst = config.w * effectiveRadius * 4.2 * SSAA;
        const pitchConst = pScale * 10.5 * SSAA;
        const rotRad = rotationDeg * Math.PI / 180;
        const vHeight = yEnd - yStart;

        for (let i = 0; i < config.w; i++) {
          
          if (layerType === 'HEAD') {
              if (i < 1 || i >= config.w - 1) continue;
          }

          let normI = (i / config.w) - 0.5;
          const sphereBulge = isHeadPart ? (Math.cos(normI * Math.PI) * 0.15) : 0;
          const adjustedNormI = normI + (normI * sphereBulge); 
          
          const angle = adjustedNormI * arc + rotRad;
          const z = Math.cos(angle);
          if (z < -0.1) continue; 
          
          const rDamp = isHeadPart ? (0.86 + (z * 0.14)) : 1.0;
          const dx = Math.round(centerX + Math.sin(angle) * radConst * rDamp);
          
          const nextAngle = (adjustedNormI + (1/config.w)) * arc + rotRad;
          const nextDx = Math.round(centerX + Math.sin(nextAngle) * radConst * rDamp);
          const stripW = Math.ceil(Math.abs(nextDx - dx) + 1.2); 

          const sourceXI = isFlipped ? (config.w - 1 - i) : i;
          
          rbufCtx.save();
          if (isHeadPart && Math.abs(pitchVal) > 0.01) {
             rbufCtx.translate(dx, bodyNeckAnchor); 
             rbufCtx.rotate(pitchVal * 0.14 * Math.sign(hRot)); 
             rbufCtx.translate(-dx, -bodyNeckAnchor);
          }
          
          rbufCtx.globalAlpha = (0.5 + (z * 0.5));
          
          const isAccordionActive = (isIdle && layerType === 'BODY');

          if (useSmartStrip && !isAccordionActive) {
              const yTop = dyBase + (yStart / config.h) * currentH;
              const yBot = dyBase + (yEnd / config.h) * currentH;
              const drawH = yBot - yTop;
              
              if (z > 0.45) rbufCtx.drawImage(bitmap, Math.max(0, Math.min(bitmap.width - 1, curSX + sourceXI)), yStart, 1, vHeight, dx + 0.6, yTop, stripW, drawH);
              rbufCtx.drawImage(bitmap, Math.max(0, Math.min(bitmap.width - 1, curSX + sourceXI)), yStart, 1, vHeight, dx, yTop, stripW, drawH);
          } else {
              const CHUNK_SIZE = isAccordionActive ? 1 : 4;
              
              for (let s = 0; s < vHeight; s += CHUNK_SIZE) {
                const actualChunkH = Math.min(CHUNK_SIZE, vHeight - s);
                const curY = yStart + s;
                
                const relS = curY - yStart;
                const sliceNormY = (relS / vHeight) - 0.5;
                const roll = (Math.sin(sliceNormY * Math.PI) * pitchConst);
                
                let accOffset = 0;
                if (isAccordionActive) {
                    const normY = relS / vHeight;
                    const mask = Math.sin(normY * Math.PI);
                    const wave = Math.sin((time * 0.002) + (curY * 0.15));
                    accOffset = wave * mask * 0.5 * SSAA;
                }

                const yCurrent = dyBase + (curY / config.h) * currentH + roll + accOffset;
                
                const endY = curY + actualChunkH;
                const relSEnd = endY - yStart;
                const sliceNormYEnd = (relSEnd / vHeight) - 0.5;
                const rollEnd = (Math.sin(sliceNormYEnd * Math.PI) * pitchConst);
                
                let accOffsetNext = 0;
                if (isAccordionActive) {
                    const normY = relSEnd / vHeight;
                    const mask = Math.sin(normY * Math.PI);
                    const wave = Math.sin((time * 0.002) + (endY * 0.15));
                    accOffsetNext = wave * mask * 0.5 * SSAA;
                }

                const yNext = dyBase + (endY / config.h) * currentH + rollEnd + accOffsetNext;
                const drawH = Math.max(1, Math.ceil(yNext - yCurrent + 1.0));
                
                if (z > 0.45) rbufCtx.drawImage(bitmap, Math.max(0, Math.min(bitmap.width - 1, curSX + sourceXI)), curY, 1, actualChunkH, dx + 0.6, yCurrent, stripW, drawH);
                rbufCtx.drawImage(bitmap, Math.max(0, Math.min(bitmap.width - 1, curSX + sourceXI)), curY, 1, actualChunkH, dx, yCurrent, stripW, drawH);
              }
          }
          rbufCtx.restore();
        }
      };

      // NO SKULL RENDER
      renderPass('BODY', 1.0, clampedBRot, 0); 
      
      if (debugView) rbufCtx.globalAlpha = 0.5;
      renderPass('HEAD', 1.0, clampedHRot, pitch);
      rbufCtx.globalAlpha = 1.0;
      
      targetCtx.imageSmoothingEnabled = true; 
      targetCtx.imageSmoothingQuality = 'high'; 
      targetCtx.drawImage(renderBuffer, 0, 0, renderBuffer.width, renderBuffer.height, x - 200, y - 200, 400, 400);
    };

    const update = () => {
      RAM[REG.TICK]++; const w = window.innerWidth, h = window.innerHeight;
      RAM[REG.PY] += RAM[REG.P_YVEL];
      if (RAM[REG.PY] < RAM[REG.P_GND_Y]) { RAM[REG.P_YVEL] += 0.8; } 
      else { RAM[REG.PY] = RAM[REG.P_GND_Y]; RAM[REG.P_YVEL] = 0; }
      RAM[REG.PX] = 0; RAM[REG.P_CLOCK] += 16.6; 
      
      let targetA = 0, targetP = 0;
      if (RAM[REG.P_IS_TOUCHING] === 1) {
          const cX = w / 2; targetA = Math.atan2(pointer.x - cX, 130) * (180 / Math.PI);
          targetP = Math.max(-1.1, Math.min(1.1, (pointer.y - h/2) / 160));
      } else {
          if (RAM[REG.PY] < RAM[REG.P_GND_Y]) { targetA = RAM[REG.P_LATCH_ROT_AIR]; targetP = RAM[REG.P_LATCH_PITCH_AIR]; } 
          else { targetA = 0; targetP = 0; }
      }
      
      let damp = 0.28;
      if (RAM[REG.P_IS_TOUCHING] === 0 && RAM[REG.PY] >= RAM[REG.P_GND_Y]) damp = 0.5; 
      else if (RAM[REG.PY] < RAM[REG.P_GND_Y]) damp = 0.15; 
      else if (RAM[REG.P_ACTIVE_ACTOR] === 0) damp = 0.22;

      RAM[REG.PH_ROT] += (targetA - RAM[REG.PH_ROT]) * damp;
      RAM[REG.P_PITCH] += (targetP - RAM[REG.P_PITCH]) * 0.22;
      RAM[REG.PB_ROT] += (targetA * 0.95 - RAM[REG.PB_ROT]) * 0.22;
    };

    const loop = () => { 
        if (loaded) { 
            update(); const w = canvas.width = window.innerWidth, h = canvas.height = window.innerHeight;
            ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, w, h);
            ctx.save(); ctx.translate(w/2, h/2); ctx.scale(RAM[REG.ZOOM], RAM[REG.ZOOM]);
            drawPuppet(ctx, 0, 0, RAM[REG.P_CLOCK], RAM[REG.PB_ROT], RAM[REG.PH_ROT], RAM[REG.P_PITCH], RAM[REG.P_ACTIVE_ACTOR] === 0 ? 'dude' : 'mummy');
            ctx.restore();
            ctx.fillStyle = '#6366f1'; ctx.font = '10px monospace';
            ctx.fillText(`Lath.js_V0.0.461 // AUTO_DEDUPLICATION`, 20, 30);
            ctx.fillText(`BODY_CHUNK: ${Math.abs(RAM[REG.PH_ROT]) < 35 && RAM[REG.PY] >= RAM[REG.P_GND_Y] ? '1px (Hi-Res)' : '4px'}`, 20, 42);
        } 
        requestAnimationFrame(loop); 
    };

    const handleInput = (e, isDown) => {
        if (isDown) {
            if (RAM[REG.P_INITIAL_SYNC] === 0) RAM[REG.P_INITIAL_SYNC] = 1;
            RAM[REG.P_IS_TOUCHING] = 1;
            RAM[REG.P_SWIPE_START_Y] = e.clientY; 
            RAM[REG.P_IS_SWIPING] = 1;
        } else {
            RAM[REG.P_IS_TOUCHING] = 0;
            if (RAM[REG.P_IS_SWIPING] === 1) {
                const deltaY = RAM[REG.P_SWIPE_START_Y] - e.clientY;
                if (deltaY > 50) {
                  RAM[REG.P_YVEL] = -15; 
                  RAM[REG.P_LATCH_ROT_AIR] = RAM[REG.PH_ROT]; RAM[REG.P_LATCH_PITCH_AIR] = RAM[REG.P_PITCH];
                  RAM[REG.P_JUMP_START_TIME] = RAM[REG.P_CLOCK];
     
