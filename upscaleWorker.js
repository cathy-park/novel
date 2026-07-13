self.importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js');
self.importScripts('https://cdn.jsdelivr.net/npm/upscaler@latest/dist/browser/umd/upscaler.min.js');
self.importScripts('https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-thick@latest/dist/umd/2x.min.js');

let upscaler;

self.onmessage = async (e) => {
  const { type, payload } = e.data;
  
  if (type === 'INIT') {
    try {
      await tf.ready();
      upscaler = new window.Upscaler({
        model: window.ESRGANThick2x
      });
      self.postMessage({ type: 'INIT_DONE' });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: err.message });
    }
  }
  
  if (type === 'UPSCALE') {
    let tensor = null;
    let currentTensor = null;
    let bitmap = null;
    try {
      const { imageDataUrl, scale, modelType } = payload;
      
      // DataURL -> Blob -> ImageBitmap -> Tensor
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      bitmap = await self.createImageBitmap(blob);
      tensor = tf.browser.fromPixels(bitmap);
      
      self.postMessage({ type: 'PROGRESS', progress: 0.05 });
      
      currentTensor = tensor;
      const passes = scale === 4 ? 2 : 1; 
      
      for (let i = 0; i < passes; i++) {
        const nextTensor = await upscaler.upscale(currentTensor, {
          patchSize: 128,
          padding: 2,
          progress: (prog) => {
            const base = i / passes;
            const current = (typeof prog === 'number' ? prog : 0) / passes;
            self.postMessage({ type: 'PROGRESS', progress: base + current });
          }
        });
        
        if (i > 0) currentTensor.dispose();
        currentTensor = nextTensor;
      }
      
      // Tensor -> OffscreenCanvas -> Blob -> DataURL
      const canvas = new OffscreenCanvas(currentTensor.shape[1], currentTensor.shape[0]);
      await tf.browser.toPixels(currentTensor, canvas);
      const resultBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      
      const reader = new FileReaderSync();
      const resultDataUrl = reader.readAsDataURL(resultBlob);
      
      // 완벽한 메모리 해제
      if (currentTensor && currentTensor !== tensor) currentTensor.dispose();
      if (tensor) tensor.dispose();
      if (bitmap) bitmap.close();
      
      self.postMessage({ type: 'UPSCALE_DONE', resultDataUrl });
      
    } catch (err) {
      if (currentTensor && currentTensor !== tensor) currentTensor.dispose();
      if (tensor) tensor.dispose();
      if (bitmap) bitmap.close();
      self.postMessage({ type: 'ERROR', error: err.message });
    }
  }
};
