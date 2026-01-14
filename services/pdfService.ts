
/**
 * Real PDF Text Extraction Service
 * Uses pdfjs-dist via ESM to parse uploaded PDF files.
 */

// We use a specific version of pdfjs-dist that is compatible with browser ESM
const PDFJS_URL = 'https://esm.sh/pdfjs-dist@4.0.379';
const PDFJS_WORKER_URL = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

export const extractTextFromPDF = async (file: File): Promise<string> => {
  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    
    let fullText = "";
    // Limit to first 20 pages to keep context window manageable for the Live API
    const pageLimit = Math.min(pdf.numPages, 20);

    for (let i = 1; i <= pageLimit; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(" ");
      fullText += `[Page ${i}]\n${pageText}\n\n`;
    }

    if (!fullText.trim()) {
      throw new Error("No text content found in PDF. It might be an image-only PDF.");
    }

    return fullText;
  } catch (error) {
    console.error("PDF Extraction Failed:", error);
    return `Error extracting text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
};
