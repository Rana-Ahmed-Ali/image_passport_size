const FORMATS = {
            'EU': { name: 'Europe/UK/AU (35x45mm)', width: 35, height: 45, headMin: 0.70, headMax: 0.80 },
            'US': { name: 'US/India (2x2")', width: 51, height: 51, headMin: 0.50, headMax: 0.69 },
            'CA': { name: 'Canada (50x70mm)', width: 50, height: 70, headMin: 0.50, headMax: 0.60 }
        };

        // ========== STATE ==========
        const state = {
            modelsLoaded: false,
            cameraActive: false,
            stream: null,
            currentSource: null,      // Image element of captured/uploaded image
            currentMode: 'camera',    // 'camera' or 'upload'
            format: 'EU',
            bgColor: '#1e63d6',
            bgTexture: false,
            showGrid: false,
            cutoutCanvas: null,       // Canvas with person cutout (transparent bg)
            cutoutInfo: null,         // { cropX, cropY, cropW, cropH }
            faceBox: null,
            srcW: 0,
            srcH: 0,
            settings: {
                brightness: 0,
                contrast: 0,
                skinSmooth: 0,
                sharpen: 0,
                warmth: 0,
                saturation: 0,
                intensity: 0,
                shadow: 0,
                ringLight: 0
            },
            adjustments: {
                zoom: 1.0,
                offsetY: 0,
                offsetX: 0,
                rotate: 0
            }
        };

        // ========== DOM ==========
        const video = document.getElementById('video');
        const canvas = document.getElementById('resultCanvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const fileInput = document.getElementById('fileInput');
        const uploadImg = document.getElementById('uploadImg');
        const uploadPreview = document.getElementById('uploadPreview');
        const cameraView = document.getElementById('cameraView');
        const uploadView = document.getElementById('uploadView');
        const cameraOff = document.getElementById('cameraOff');
        const faceGuide = document.getElementById('faceGuide');
        const emptyState = document.getElementById('emptyState');
        const processingOverlay = document.getElementById('processingOverlay');
        const scanLine = document.getElementById('scanLine');
        const liveIndicator = document.getElementById('liveIndicator');
        const dropZone = document.querySelector('.drop-zone');

        // ========== UTILS ==========
        function toast(message, type = 'info') {
            const t = document.getElementById('toast');
            const icon = type === 'success' ? 'fa-circle-check' :
                type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
            t.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
            t.className = `toast show ${type}`;
            clearTimeout(t._timer);
            t._timer = setTimeout(() => t.classList.remove('show'), 3200);
        }

        function clamp(v) { return Math.max(0, Math.min(255, v)); }

        // Smooth S-curve for cinematic contrast
        function sCurve(x) {
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            const a = 2.4;
            const xa = Math.pow(x, a);
            const oxa = Math.pow(1 - x, a);
            return xa / (xa + oxa);
        }

        // Draw image section that can safely exceed the source canvas boundary by padding background
        function drawSourceToDestination(ctx, srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh) {
            const srcW = srcCanvas.width;
            const srcH = srcCanvas.height;

            const sLeft = Math.max(0, sx);
            const sTop = Math.max(0, sy);
            const sRight = Math.min(srcW, sx + sw);
            const sBottom = Math.min(srcH, sy + sh);

            if (sLeft >= sRight || sTop >= sBottom) {
                return; // Nothing to draw
            }

            const intersectW = sRight - sLeft;
            const intersectH = sBottom - sTop;

            const scaleX = dw / sw;
            const scaleY = dh / sh;

            const dLeft = dx + (sLeft - sx) * scaleX;
            const dTop = dy + (sTop - sy) * scaleY;
            const dWidth = intersectW * scaleX;
            const dHeight = intersectH * scaleY;

            ctx.drawImage(srcCanvas, sLeft, sTop, intersectW, intersectH, dLeft, dTop, dWidth, dHeight);
        }

        // ========== MEDIAPIPE ==========
        let faceDetector = null;
        let selfieSegmenter = null;

        async function loadModels() {
            try {
                faceDetector = new FaceDetection({
                    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
                });
                faceDetector.setOptions({
                    model: 'short',
                    minDetectionConfidence: 0.5
                });

                selfieSegmenter = new SelfieSegmentation({
                    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
                });
                selfieSegmenter.setOptions({
                    modelSelection: 1,
                    selfieMode: false
                });

                // Warm up both models
                await faceDetector.initialize();
                await selfieSegmenter.initialize();

                state.modelsLoaded = true;
                const statusEl = document.getElementById('modelStatus');
                statusEl.classList.remove('pulse');
                statusEl.style.background = 'var(--success)';
                document.getElementById('modelStatusText').textContent = 'AI ready';
                toast('AI models loaded — ready to shoot', 'success');
            } catch (err) {
                console.error(err);
                document.getElementById('modelStatusText').textContent = 'Model load failed';
                document.getElementById('modelStatus').style.background = 'var(--danger)';
                toast('Failed to load AI models. Check your connection.', 'error');
            }
        }

        function detectFaces(image) {
            return new Promise((resolve, reject) => {
                let resolved = false;
                faceDetector.onResults((results) => {
                    if (!resolved) { resolved = true; resolve(results); }
                });
                faceDetector.send({ image }).catch(reject);
            });
        }

        function segmentImage(image) {
            return new Promise((resolve, reject) => {
                let resolved = false;
                selfieSegmenter.onResults((results) => {
                    if (!resolved) { resolved = true; resolve(results); }
                });
                selfieSegmenter.send({ image }).catch(reject);
            });
        }

        // ========== CAMERA ==========
        async function startCamera() {
            if (!state.modelsLoaded) {
                toast('AI models still loading, please wait...', 'error');
                return;
            }
            try {
                state.stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' },
                    audio: false
                });
                video.srcObject = state.stream;
                await video.play();
                state.cameraActive = true;
                cameraOff.classList.add('hidden');
                liveIndicator.classList.remove('hidden');
                document.getElementById('captureBtn').disabled = false;
                detectInLoop();
                toast('Camera started — position your face in the guide', 'success');
            } catch (err) {
                console.error(err);
                toast('Cannot access camera. Try upload instead.', 'error');
            }
        }

        let lastDetectTime = 0;
        function detectInLoop() {
            if (!state.cameraActive) return;
            const now = performance.now();
            if (now - lastDetectTime > 120) { // ~8fps detection
                lastDetectTime = now;
                if (state.modelsLoaded && video.readyState >= 2) {
                    detectFaces(video).then(results => {
                        const detected = results.detections && results.detections.length > 0;
                        faceGuide.classList.toggle('detected', detected);
                    }).catch(() => { });
                }
            }
            requestAnimationFrame(detectInLoop);
        }

        function stopCamera() {
            if (state.stream) {
                state.stream.getTracks().forEach(t => t.stop());
                state.stream = null;
            }
            state.cameraActive = false;
            cameraOff.classList.remove('hidden');
            liveIndicator.classList.add('hidden');
            faceGuide.classList.remove('detected');
            document.getElementById('captureBtn').disabled = true;
        }

        // ========== CAPTURE & UPLOAD ==========
        async function capturePhoto() {
            if (!state.cameraActive) return;
            const snapCanvas = document.createElement('canvas');
            snapCanvas.width = video.videoWidth;
            snapCanvas.height = video.videoHeight;
            const snapCtx = snapCanvas.getContext('2d');
            // Capture un-mirrored (true orientation)
            snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);

            const img = new Image();
            img.onload = async () => {
                state.currentSource = img;
                await processImage();
            };
            img.src = snapCanvas.toDataURL('image/png');
        }

        function handleUpload(file) {
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                toast('Please select an image file', 'error');
                return;
            }
            if (file.size > 10 * 1024 * 1024) {
                toast('File too large (max 10MB)', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                uploadImg.onload = () => {
                    uploadPreview.classList.remove('hidden');
                    uploadPreview.classList.add('fade-in');
                    state.currentSource = uploadImg;
                    document.getElementById('processBtn').disabled = false;
                    toast('Image loaded — click Process to continue', 'success');
                };
                uploadImg.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }

        // We no longer downscale the source to preserve maximum pixel quality for the final crop
        function getOptimalSource(source) {
            return source;
        }

        // ========== MAIN PROCESSING ==========
        function calculateCrop() {
            if (!state.faceBox) return;
            const fmt = FORMATS[state.format];
            const targetAspect = fmt.width / fmt.height;
            const srcW = state.srcW;
            const srcH = state.srcH;
            
            const faceW = state.faceBox.width * srcW;
            const faceH = state.faceBox.height * srcH;
            const faceCx = state.faceBox.xCenter * srcW;
            const faceCy = state.faceBox.yCenter * srcH;

            // Estimate head height (face box is eyebrows to chin, full head includes hair)
            const headHeight = faceH * 1.8;
            
            // Adjust framing based on target country's head percentage requirement
            const headTarget = (fmt.headMin + fmt.headMax) / 2;
            const frameHeight = headHeight / headTarget;
            const frameWidth = frameHeight * targetAspect;

            state.cutoutInfo = {
                cropX: faceCx - frameWidth / 2,
                cropY: faceCy - frameHeight * 0.50,
                cropW: frameWidth,
                cropH: frameHeight
            };
        }

        async function processImage() {
            if (!state.currentSource || !state.modelsLoaded) {
                toast('Nothing to process yet', 'error');
                return;
            }
            emptyState.classList.add('hidden');
            processingOverlay.classList.remove('hidden');
            scanLine.classList.remove('hidden');

            try {
                const source = getOptimalSource(state.currentSource);
                // MUST prioritize naturalWidth, otherwise DOM elements return their CSS layout size!
                const srcW = source.naturalWidth || source.videoWidth || source.width;
                const srcH = source.naturalHeight || source.videoHeight || source.height;
                state.srcW = srcW;
                state.srcH = srcH;

                // 1. Face detection
                document.getElementById('processingText').textContent = 'Detecting face...';
                const faceResults = await detectFaces(source);
                let faceBox = null;
                if (faceResults.detections && faceResults.detections.length > 0) {
                    faceBox = faceResults.detections[0].boundingBox;
                }
                state.faceBox = faceBox;

                // 2. Selfie segmentation
                document.getElementById('processingText').textContent = 'Removing background...';
                const segResults = await segmentImage(source);

                // 3. Build cutout (person pixels, transparent bg)
                document.getElementById('processingText').textContent = 'Compositing...';
                const cutout = document.createElement('canvas');
                cutout.width = srcW;
                cutout.height = srcH;
                const cutoutCtx = cutout.getContext('2d');
                
                // Add slight blur to mask to fix jagged/pixelated edges
                cutoutCtx.filter = 'blur(1px)';
                cutoutCtx.drawImage(segResults.segmentationMask, 0, 0, srcW, srcH);
                cutoutCtx.filter = 'none';
                
                cutoutCtx.globalCompositeOperation = 'source-in';
                cutoutCtx.drawImage(source, 0, 0, srcW, srcH);

                // 4. Calculate crop rectangle dynamically
                document.getElementById('processingText').textContent = 'Cropping to target size...';
                state.cutoutCanvas = cutout;
                if (state.faceBox) {
                    calculateCrop();
                } else {
                    const fmt = FORMATS[state.format];
                    const targetAspect = fmt.width / fmt.height;
                    let cropX, cropY, cropW, cropH;
                    if (srcW / srcH > targetAspect) {
                        cropH = srcH; cropW = cropH * targetAspect;
                        cropX = (srcW - cropW) / 2; cropY = 0;
                    } else {
                        cropW = srcW; cropH = cropW / targetAspect;
                        cropX = 0; cropY = (srcH - cropH) / 2;
                    }
                    state.cutoutInfo = { cropX, cropY, cropW, cropH };
                    toast('No face detected — used center crop', 'error');
                }

                // 5. Render final result
                document.getElementById('processingText').textContent = 'Applying enhancements...';
                renderResult();

                processingOverlay.classList.add('hidden');
                scanLine.classList.add('hidden');
                document.getElementById('downloadBtn').disabled = false;
                document.getElementById('downloadSheetBtn').disabled = false;
                document.getElementById('retakeBtn').disabled = false;

                toast('Photo ready — click Download', 'success');
            } catch (err) {
                console.error(err);
                processingOverlay.classList.add('hidden');
                scanLine.classList.add('hidden');
                emptyState.classList.remove('hidden');
                toast('Processing failed: ' + (err.message || 'unknown error'), 'error');
            }
        }

        // ========== RENDER (re-runs on every control change) ==========
        let renderQueued = false;
        function queueRender() {
            if (renderQueued || !state.cutoutCanvas) return;
            renderQueued = true;
            requestAnimationFrame(() => {
                renderQueued = false;
                renderResult();
            });
        }

        function drawSourceToDestinationRotated(ctx, srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh, angleDeg) {
            if (angleDeg === 0) {
                drawSourceToDestination(ctx, srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
                return;
            }
            ctx.save();
            ctx.translate(dx + dw/2, dy + dh/2);
            ctx.rotate(angleDeg * Math.PI / 180);
            drawSourceToDestination(ctx, srcCanvas, sx, sy, sw, sh, -dw/2, -dh/2, dw, dh);
            ctx.restore();
        }

        function renderResult() {
            if (!state.cutoutCanvas || !state.cutoutInfo) return;
            let { cropX, cropY, cropW, cropH } = state.cutoutInfo;
            const fmt = FORMATS[state.format];

            canvas.width = 600;
            canvas.height = Math.round(600 * fmt.height / fmt.width); 

            // Apply zoom adjustment
            const zoom = state.adjustments.zoom;
            const newW = cropW / zoom;
            const newH = cropH / zoom;
            cropX = cropX + (cropW - newW) / 2;
            cropY = cropY + (cropH - newH) / 2;
            cropW = newW;
            cropH = newH;

            // Apply offsets
            cropX -= (state.adjustments.offsetX / 100) * cropW;
            cropY += (state.adjustments.offsetY / 100) * cropH;

            // Fill background
            ctx.fillStyle = state.bgColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Studio Texture Gradient
            if (state.bgTexture) {
                const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, canvas.width*0.1, canvas.width/2, canvas.height/2, canvas.width);
                grad.addColorStop(0, 'rgba(255,255,255,0.15)');
                grad.addColorStop(1, 'rgba(0,0,0,0.3)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // Backdrop Shadow
            if (state.settings.shadow > 0) {
                ctx.save();
                ctx.shadowColor = `rgba(0,0,0,${state.settings.shadow / 100 * 0.8})`;
                ctx.shadowBlur = 40 + (state.settings.shadow / 2);
                ctx.shadowOffsetX = 10;
                ctx.shadowOffsetY = 20;
                drawSourceToDestinationRotated(ctx, state.cutoutCanvas, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height, state.adjustments.rotate);
                ctx.restore();
            }

            // Draw cutout
            drawSourceToDestinationRotated(ctx, state.cutoutCanvas, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height, state.adjustments.rotate);

            // Ring Light
            if (state.settings.ringLight > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'soft-light';
                const grad = ctx.createRadialGradient(canvas.width/2, canvas.height*0.4, 0, canvas.width/2, canvas.height*0.4, canvas.width*0.6);
                grad.addColorStop(0, `rgba(255,255,255,${state.settings.ringLight/100 * 0.8})`);
                grad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
            }

            // Enhancement pass
            applyEnhancement();
            // Skin smoothing pass
            if (state.settings.skinSmooth > 0) applySkinSmoothing(state.settings.skinSmooth);
            // Sharpen pass
            if (state.settings.sharpen > 0) applySharpen(state.settings.sharpen / 100);
            // Color grade pass
            applyColorGrading();

            // ICAO Grid Overlay
            if (state.showGrid) {
                ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                
                // Head top guideline
                const topY = canvas.height * (1 - fmt.headMax) / 2;
                ctx.beginPath(); ctx.moveTo(0, topY); ctx.lineTo(canvas.width, topY); ctx.stroke();
                
                // Chin guideline
                const bottomY = topY + canvas.height * fmt.headMax;
                ctx.beginPath(); ctx.moveTo(0, bottomY); ctx.lineTo(canvas.width, bottomY); ctx.stroke();

                // Center line
                ctx.beginPath(); ctx.moveTo(canvas.width/2, 0); ctx.lineTo(canvas.width/2, canvas.height); ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        function applyEnhancement() {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const brightness = state.settings.brightness;
            const c = state.settings.contrast;
            const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));
            const sat = 1 + state.settings.saturation / 100;

            for (let i = 0; i < data.length; i += 4) {
                let r = data[i] + brightness;
                let g = data[i + 1] + brightness;
                let b = data[i + 2] + brightness;

                // Contrast
                r = contrastFactor * (r - 128) + 128;
                g = contrastFactor * (g - 128) + 128;
                b = contrastFactor * (b - 128) + 128;

                // Saturation
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = gray + (r - gray) * sat;
                g = gray + (g - gray) * sat;
                b = gray + (b - gray) * sat;

                data[i] = clamp(r);
                data[i + 1] = clamp(g);
                data[i + 2] = clamp(b);
            }
            ctx.putImageData(imageData, 0, 0);
        }

        function applySkinSmoothing(amount) {
            if (amount <= 0) return;
            
            const w = canvas.width;
            const h = canvas.height;
            
            // Create blurred version for surface blur
            const blurRadius = (amount / 100) * 8;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.filter = `blur(${blurRadius}px)`;
            tempCtx.drawImage(canvas, 0, 0);
            
            const origData = ctx.getImageData(0, 0, w, h);
            const blurData = tempCtx.getImageData(0, 0, w, h);
            const outData = new Uint8ClampedArray(origData.data);
            
            // Threshold for edge detection
            const threshold = 30 + (amount * 0.4); 
            
            for (let i = 0; i < outData.length; i += 4) {
                const r = origData.data[i];
                const g = origData.data[i+1];
                const b = origData.data[i+2];
                
                const br = blurData.data[i];
                const bg = blurData.data[i+1];
                const bb = blurData.data[i+2];
                
                // Calculate difference (edge map)
                const diff = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
                
                // If difference is small, it's a flat texture (like skin). If large, it's an edge (eyes/hair).
                if (diff < threshold) {
                    const mix = 1 - (diff / threshold);
                    outData[i]   = r * (1 - mix) + br * mix;
                    outData[i+1] = g * (1 - mix) + bg * mix;
                    outData[i+2] = b * (1 - mix) + bb * mix;
                }
            }
            ctx.putImageData(new ImageData(outData, w, h), 0, 0);
        }

        function applySharpen(amount) {
            const w = canvas.width;
            const h = canvas.height;
            const imageData = ctx.getImageData(0, 0, w, h);
            const src = imageData.data;
            const dst = new Uint8ClampedArray(src);
            const center = 1 + amount * 4;
            const side = -amount;

            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const idx = (y * w + x) * 4;
                    for (let c = 0; c < 3; c++) {
                        const i = idx + c;
                        const val = src[i] * center
                            + src[i - 4] * side
                            + src[i + 4] * side
                            + src[i - w * 4] * side
                            + src[i + w * 4] * side;
                        dst[i] = clamp(val);
                    }
                }
            }
            ctx.putImageData(new ImageData(dst, w, h), 0, 0);
        }

        function applyColorGrading() {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const warmth = state.settings.warmth;
            const intensity = state.settings.intensity / 100;

            for (let i = 0; i < data.length; i += 4) {
                let r = data[i];
                let g = data[i + 1];
                let b = data[i + 2];

                const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                // S-curve for cinematic contrast
                const curved = sCurve(lum);
                const lumDiff = (curved - lum) * 255 * intensity * 0.4;
                r += lumDiff; g += lumDiff; b += lumDiff;

                // Warm tint
                r += warmth * intensity * 0.4;
                b -= warmth * intensity * 0.4;

                // Subtle teal-orange split (cinematic)
                if (lum < 0.4) {
                    // Shadows: lift shadows slightly toward teal
                    b += 4 * intensity;
                    g += 1 * intensity;
                } else if (lum > 0.6) {
                    // Highlights: push slightly warm
                    r += 4 * intensity;
                }

                data[i] = clamp(r);
                data[i + 1] = clamp(g);
                data[i + 2] = clamp(b);
            }
            ctx.putImageData(imageData, 0, 0);
        }

        // ========== DOWNLOAD ==========
        function download() {
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            link.download = `passport-photo-${timestamp}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            toast('Photo downloaded', 'success');
        }

        function downloadSheet() {
            if (!state.cutoutCanvas || !state.cutoutInfo) return;
            
            // 4x6 inches at 300 DPI is 1800x1200 pixels
            const sheetCanvas = document.createElement('canvas');
            sheetCanvas.width = 1800;
            sheetCanvas.height = 1200;
            const sCtx = sheetCanvas.getContext('2d');
            
            // Fill white background for paper
            sCtx.fillStyle = '#ffffff';
            sCtx.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height);
            
            // Passport size at 300 DPI
            const fmt = FORMATS[state.format];
            const dpi = 300;
            const mmToInch = 1 / 25.4;
            const pWidth = Math.round(fmt.width * mmToInch * dpi);
            const pHeight = Math.round(fmt.height * mmToInch * dpi);
            
            // Layout: 2 rows, 3 cols = 6 photos
            const cols = 3;
            const rows = 2;
            const gapX = 100;
            const gapY = 80;
            
            const totalGridW = cols * pWidth + gapX * (cols - 1);
            const totalGridH = rows * pHeight + gapY * (rows - 1);
            
            const startX = (sheetCanvas.width - totalGridW) / 2;
            const startY = (sheetCanvas.height - totalGridH) / 2;
            
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const x = startX + c * (pWidth + gapX);
                    const y = startY + r * (pHeight + gapY);
                    
                    sCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, pWidth, pHeight);
                    
                    // Draw cut lines (faint grey border)
                    sCtx.strokeStyle = '#cccccc';
                    sCtx.lineWidth = 2;
                    sCtx.setLineDash([15, 10]);
                    sCtx.strokeRect(x, y, pWidth, pHeight);
                    sCtx.setLineDash([]); // reset
                }
            }
            
            // Add a little instruction text at the bottom
            sCtx.fillStyle = '#888888';
            sCtx.font = '24px sans-serif';
            sCtx.textAlign = 'center';
            sCtx.fillText('Passport Studio — Print on 4x6" (10x15cm) Photo Paper at 100% Scale', sheetCanvas.width / 2, sheetCanvas.height - 30);
            
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            link.download = `passport-4x6-print-sheet-${timestamp}.png`;
            link.href = sheetCanvas.toDataURL('image/png');
            link.click();
            toast('Print sheet generated and downloaded', 'success');
        }

        // ========== UI WIRING ==========
        function setTab(tab) {
            state.currentMode = tab;
            document.getElementById('tabCamera').classList.toggle('active', tab === 'camera');
            document.getElementById('tabUpload').classList.toggle('active', tab === 'upload');
            cameraView.classList.toggle('hidden', tab !== 'camera');
            uploadView.classList.toggle('hidden', tab !== 'upload');
            if (tab === 'camera') {
                document.getElementById('captureBtn').disabled = !state.cameraActive;
                document.getElementById('processBtn').disabled = true;
            } else {
                document.getElementById('captureBtn').disabled = true;
                document.getElementById('processBtn').disabled = !state.currentSource;
            }
        }

        function updateBgColor(color) {
            state.bgColor = color;
            document.getElementById('bgColorPicker').value = color;
            document.getElementById('bgColorText').value = color;
            document.querySelectorAll('.color-swatch').forEach(s => {
                s.classList.toggle('active', s.dataset.color?.toLowerCase() === color.toLowerCase());
            });
            saveState();
            queueRender();
        }

        function saveState() {
            try {
                localStorage.setItem('passport_settings', JSON.stringify(state.settings));
                localStorage.setItem('passport_adjustments', JSON.stringify(state.adjustments));
                localStorage.setItem('passport_bgColor', state.bgColor);
            } catch (e) {
                console.error('Failed to save state to localStorage', e);
            }
        }

        function loadState() {
            try {
                const savedSettings = localStorage.getItem('passport_settings');
                if (savedSettings) {
                    Object.assign(state.settings, JSON.parse(savedSettings));
                }
                const savedAdjustments = localStorage.getItem('passport_adjustments');
                if (savedAdjustments) {
                    Object.assign(state.adjustments, JSON.parse(savedAdjustments));
                }
                const savedBgColor = localStorage.getItem('passport_bgColor');
                if (savedBgColor) {
                    state.bgColor = savedBgColor;
                }
            } catch (e) {
                console.error('Failed to load state from localStorage', e);
            }
        }

        function applyStateToUI() {
            // Bg Color
            updateBgColor(state.bgColor);

            // Settings
            for (const [key, val] of Object.entries(state.settings)) {
                const input = document.getElementById(key);
                const display = document.getElementById(key + 'Val');
                if (input) input.value = val;
                if (display) {
                    if (key === 'skinSmooth' || key === 'sharpen' || key === 'intensity') {
                        display.textContent = val + '%';
                    } else {
                        display.textContent = val >= 0 ? '+' + val : val;
                    }
                }
            }

            // Adjustments
            document.getElementById('zoom').value = state.adjustments.zoom;
            document.getElementById('zoomVal').textContent = Math.round(state.adjustments.zoom * 100) + '%';
            document.getElementById('offsetY').value = state.adjustments.offsetY;
            document.getElementById('offsetYVal').textContent = (state.adjustments.offsetY >= 0 ? '+' : '') + state.adjustments.offsetY + '%';
            document.getElementById('offsetX').value = state.adjustments.offsetX;
            document.getElementById('offsetXVal').textContent = (state.adjustments.offsetX >= 0 ? '+' : '') + state.adjustments.offsetX + '%';
        }

        function updateSetting(key, value, displayValue) {
            state.settings[key] = parseInt(value);
            const valEl = document.getElementById(key + 'Val');
            if (valEl) valEl.textContent = displayValue !== undefined ? displayValue : (value >= 0 ? '+' + value : value);
            queueRender();
        }

        function resetControls() {
            state.settings = { brightness: 0, contrast: 0, skinSmooth: 0, sharpen: 0, warmth: 0, saturation: 0, intensity: 0 };
            state.adjustments = { zoom: 1.0, offsetY: 0, offsetX: 0 };
            document.getElementById('brightness').value = 0;
            document.getElementById('contrast').value = 0;
            document.getElementById('skinSmooth').value = 0;
            document.getElementById('sharpen').value = 0;
            document.getElementById('warmth').value = 0;
            document.getElementById('saturation').value = 0;
            document.getElementById('intensity').value = 0;
            document.getElementById('brightnessVal').textContent = '+0';
            document.getElementById('contrastVal').textContent = '+0';
            document.getElementById('skinSmoothVal').textContent = '0%';
            document.getElementById('sharpenVal').textContent = '0%';
            document.getElementById('warmthVal').textContent = '+0';
            document.getElementById('saturationVal').textContent = '+0';
            document.getElementById('intensityVal').textContent = '0%';

            document.getElementById('zoom').value = 1.0;
            document.getElementById('offsetY').value = 0;
            document.getElementById('offsetX').value = 0;
            document.getElementById('zoomVal').textContent = '100%';
            document.getElementById('offsetYVal').textContent = '0%';
            document.getElementById('offsetXVal').textContent = '0%';

            updateBgColor('#1e63d6');
            toast('Controls reset to defaults', 'success');
        }

        function clampVal(val, min, max) {
            return Math.max(min, Math.min(max, val));
        }

        function autoEnhance() {
            if (!state.cutoutCanvas || !state.cutoutInfo) {
                toast('Please process a photo first', 'error');
                return;
            }

            const { cropX, cropY, cropW, cropH } = state.cutoutInfo;
            
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = cropW;
            tempCanvas.height = cropH;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            
            // Draw just the cropped part of the cutout (which has transparent background)
            drawSourceToDestination(tempCtx, state.cutoutCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            
            const imageData = tempCtx.getImageData(0, 0, cropW, cropH);
            const data = imageData.data;
            
            let totalLum = 0;
            let pixelCount = 0;
            let minLum = 255;
            let maxLum = 0;
            
            for (let i = 0; i < data.length; i += 4) {
                // Only analyze non-transparent pixels (the person's face/body)
                if (data[i + 3] > 128) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    
                    totalLum += lum;
                    pixelCount++;
                    
                    if (lum < minLum) minLum = lum;
                    if (lum > maxLum) maxLum = lum;
                }
            }
            
            if (pixelCount === 0) return;
            
            const avgLum = totalLum / pixelCount;
            
            // Target luminance for a well-lit studio photo
            const targetLum = 135;
            let brightnessAdjust = targetLum - avgLum;
            brightnessAdjust = clampVal(brightnessAdjust, -30, 40);
            
            // Contrast adjustment based on dynamic range
            const dynamicRange = maxLum - minLum;
            let contrastAdjust = 0;
            if (dynamicRange < 150) { 
                contrastAdjust = 15;
            } else if (dynamicRange > 230) { 
                contrastAdjust = -5;
            }
            
            // Apply calculated and standard studio settings
            state.settings.brightness = Math.round(brightnessAdjust);
            state.settings.contrast = contrastAdjust;
            state.settings.skinSmooth = 30;
            state.settings.sharpen = 15;
            state.settings.warmth = 8;
            state.settings.saturation = 5;
            state.settings.intensity = 15;
            
            applyStateToUI();
            saveState();
            queueRender();
            
            toast('Auto-Studio applied!', 'success');
        }

        function retake() {
            state.cutoutCanvas = null;
            state.cutoutInfo = null;
            state.currentSource = null;
            ctx.fillStyle = '#1a1614';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            emptyState.classList.remove('hidden');
            document.getElementById('downloadBtn').disabled = true;
            document.getElementById('downloadSheetBtn').disabled = true;
            document.getElementById('retakeBtn').disabled = true;
            uploadPreview.classList.add('hidden');
            uploadImg.src = '';
            document.getElementById('processBtn').disabled = true;
            toast('Ready for next photo', 'success');
        }

        // ========== EVENT LISTENERS ==========
        document.getElementById('startCamera').addEventListener('click', startCamera);
        document.getElementById('captureBtn').addEventListener('click', capturePhoto);
        document.getElementById('processBtn').addEventListener('click', processImage);
        document.getElementById('downloadBtn').addEventListener('click', download);
        document.getElementById('downloadSheetBtn').addEventListener('click', downloadSheet);
        document.getElementById('retakeBtn').addEventListener('click', retake);
        document.getElementById('resetControls').addEventListener('click', resetControls);
        document.getElementById('autoEnhanceBtn').addEventListener('click', autoEnhance);

        document.getElementById('tabCamera').addEventListener('click', () => setTab('camera'));
        document.getElementById('tabUpload').addEventListener('click', () => setTab('upload'));

        // File upload
        fileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) handleUpload(e.target.files[0]);
        });

        // Drag and drop
        ['dragover', 'dragenter'].forEach(ev => {
            dropZone.addEventListener(ev, (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });
        });
        ['dragleave', 'dragend'].forEach(ev => {
            dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover'));
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]);
        });

        document.getElementById('clearUpload').addEventListener('click', () => {
            uploadPreview.classList.add('hidden');
            uploadImg.src = '';
            state.currentSource = null;
            document.getElementById('processBtn').disabled = true;
            fileInput.value = '';
        });

        // Background color
        document.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => updateBgColor(swatch.dataset.color));
        });
        document.getElementById('bgColorPicker').addEventListener('input', (e) => updateBgColor(e.target.value));
        document.getElementById('bgColorText').addEventListener('change', (e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) updateBgColor(v);
            else e.target.value = state.bgColor;
        });
        // Checkboxes & Format
        document.getElementById('countryFormat').addEventListener('change', (e) => {
            state.format = e.target.value;
            // Recalculate crop based on new format, then render
            if (state.faceBox && state.currentSource) {
                calculateCrop();
            }
            queueRender();
        });
        document.getElementById('bgTexture').addEventListener('change', (e) => {
            state.bgTexture = e.target.checked;
            queueRender();
        });
        document.getElementById('showGrid').addEventListener('change', (e) => {
            state.showGrid = e.target.checked;
            queueRender();
        });

        // Sliders
        document.getElementById('zoom').addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            state.adjustments.zoom = v;
            document.getElementById('zoomVal').textContent = Math.round(v * 100) + '%';
            saveState();
            queueRender();
        });
        document.getElementById('offsetY').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.adjustments.offsetY = v;
            document.getElementById('offsetYVal').textContent = (v >= 0 ? '+' : '') + v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('offsetX').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.adjustments.offsetX = v;
            document.getElementById('offsetXVal').textContent = (v >= 0 ? '+' : '') + v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('rotate').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.adjustments.rotate = v;
            document.getElementById('rotateVal').textContent = v + '°';
            saveState();
            queueRender();
        });
        document.getElementById('shadow').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.shadow = v;
            document.getElementById('shadowVal').textContent = v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('ringLight').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.ringLight = v;
            document.getElementById('ringLightVal').textContent = v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('brightness').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.brightness = v;
            document.getElementById('brightnessVal').textContent = v >= 0 ? '+' + v : v;
            saveState();
            queueRender();
        });
        document.getElementById('contrast').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.contrast = v;
            document.getElementById('contrastVal').textContent = v >= 0 ? '+' + v : v;
            saveState();
            queueRender();
        });
        document.getElementById('skinSmooth').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.skinSmooth = v;
            document.getElementById('skinSmoothVal').textContent = v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('sharpen').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.sharpen = v;
            document.getElementById('sharpenVal').textContent = v + '%';
            saveState();
            queueRender();
        });
        document.getElementById('warmth').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.warmth = v;
            document.getElementById('warmthVal').textContent = v >= 0 ? '+' + v : v;
            saveState();
            queueRender();
        });
        document.getElementById('saturation').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.saturation = v;
            document.getElementById('saturationVal').textContent = v >= 0 ? '+' + v : v;
            saveState();
            queueRender();
        });
        document.getElementById('intensity').addEventListener('input', (e) => {
            const v = parseInt(e.target.value);
            state.settings.intensity = v;
            document.getElementById('intensityVal').textContent = v + '%';
            saveState();
            queueRender();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.code === 'Space' && state.cameraActive && state.currentMode === 'camera') {
                e.preventDefault();
                capturePhoto();
            } else if (e.key === 'd' && !document.getElementById('downloadBtn').disabled) {
                download();
            }
        });

        window.addEventListener('beforeunload', () => {
            if (state.stream) state.stream.getTracks().forEach(t => t.stop());
        });

        // ========== INIT ==========
        window.addEventListener('load', () => {
            loadState();
            applyStateToUI();
            loadModels();
        });
