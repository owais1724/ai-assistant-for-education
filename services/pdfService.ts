
/**
 * Advanced PDF Text Extraction Service
 */

const PDFJS_URL = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.mjs';
const PDFJS_WORKER_URL = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

export const extractTextFromPDF = async (file: File): Promise<string> => {
  if (!file) throw new Error("No file provided.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Textbook too large (Max 20MB).");
  if (file.type !== 'application/pdf') throw new Error("Invalid format. Murshid AI requires a PDF file.");

  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ 
      data: arrayBuffer,
      disableFontFace: true,
      verbosity: 0 
    });
    
    const pdf = await loadingTask.promise;
    let fullText = "";
    const pageLimit = Math.min(pdf.numPages, 50);

    for (let i = 1; i <= pageLimit; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      
      const items = (textContent.items as any[]).sort((a, b) => {
        const yDiff = b.transform[5] - a.transform[5];
        if (Math.abs(yDiff) > 4) return yDiff;
        return a.transform[4] - b.transform[4];
      });

      let currentLineText = "";
      let lastY = -1;
      let pageText = "";
      
      for (const item of items) {
        if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 4) {
          pageText += currentLineText.trim() + "\n";
          currentLineText = "";
        }
        currentLineText += item.str + " ";
        lastY = item.transform[5];
      }
      pageText += currentLineText.trim();
      
      if (pageText.trim().length > 5) {
        fullText += `--- PAGE ${i} ---\n${pageText}\n\n`;
      }
    }

    const finalContent = fullText.trim();
    if (!finalContent || finalContent.length < 20) {
      throw new Error("Scanned PDF Detected: No selectable text found. Please upload a digital PDF.");
    }

    return finalContent;
    
  } catch (error: any) {
    console.error("PDF Extraction Failed:", error);
    throw new Error(`Failed to read PDF: ${error.message}`);
  }
};
