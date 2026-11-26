export async function preparePhoto(file: File) {
  if (!file || file.size > 24 * 1024 * 1024) throw Error('אפשר לבחור תמונה עד 24MB');
  const url = URL.createObjectURL(file);
  try {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const scale = Math.min(1, 1600 / Math.max(picture.width, picture.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.width * scale));
    canvas.height = Math.max(1, Math.round(picture.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('Canvas unavailable');
    for (const quality of [.84, .7, .55, .42]) {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= 335000) return data;
      if (quality < .71) {
        canvas.width = Math.max(1, Math.round(canvas.width * .83));
        canvas.height = Math.max(1, Math.round(canvas.height * .83));
      }
    }
    throw Error('נסה תמונה קטנה יותר');
  } catch (error) {
    if (error instanceof Error && error.name === 'EncodingError') throw Error('הדפדפן אינו קורא את התמונה. אפשר לבחור JPEG או PNG.');
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
