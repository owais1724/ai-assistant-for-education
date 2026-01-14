
// This would typically use pdfjs-dist but for the sake of this demo, 
// we'll use a standard file reader and note that in a real environment 
// we'd extract text properly.
export const extractTextFromPDF = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Dummy extraction for demo purposes. 
      // In production, we use pdfjs-dist here.
      resolve(`This is a mock content extracted from ${file.name}. 
      Chapter 1: The Solar System. The Sun is at the center of the solar system. 
      It is a star. There are 8 planets. Jupiter is the largest.`);
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};
