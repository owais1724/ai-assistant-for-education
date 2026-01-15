
/**
 * Advanced PDF Text Extraction Service
 * Uses pdfjs-dist via ESM to parse uploaded PDF files.
 * Optimized for complex academic layouts and column-aware reading.
 */

const PDFJS_URL = 'https://esm.sh/pdfjs-dist@4.0.379';
const PDFJS_WORKER_URL = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

export const extractTextFromPDF = async (file: File): Promise<string> => {
  // 1. Basic Pre-validation
  if (!file) throw new Error("No file provided.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Textbook too large (Max 20MB). Please upload a smaller chapter for better accuracy.");
  if (file.type !== 'application/pdf') throw new Error("Invalid format. Murshid AI requires a PDF file.");

  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const arrayBuffer = await file.arrayBuffer();
    
    // Check for zero-byte or corrupted header
    if (arrayBuffer.byteLength < 10) throw new Error("The PDF file is corrupted or empty.");

    const loadingTask = pdfjs.getDocument({ 
      data: arrayBuffer,
      // Disable font face loading to speed up text-only extraction
      disableFontFace: true,
      verbosity: 0 
    });
    
    // Handle password-protected files
    loadingTask.onPassword = () => {
        throw new Error("Password Protected: Murshid cannot read encrypted PDFs. Please remove the password first.");
    };

    const pdf = await loadingTask.promise;
    
    let fullText = "";
    // Process up to 50 pages to maintain high reasoning quality without hitting context limits
    const pageLimit = Math.min(pdf.numPages, 50);

    for (let i = 1; i <= pageLimit; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      
      /**
       * LAYOUT RECONSTRUCTION:
       * PDF text items are often out of order. We sort by Y (vertical) then X (horizontal)
       * to reconstruct a natural reading flow, especially for multi-column pages.
       */
      const items = (textContent.items as any[]).sort((a, b) => {
        // transform[5] is the Y-coordinate (bottom-up in PDF space)
        const yDiff = b.transform[5] - a.transform[5];
        if (Math.abs(yDiff) > 4) return yDiff; // Tolerance for slight line misalignments
        // transform[4] is the X-coordinate
        return a.transform[4] - b.transform[4];
      });

      let pageLines: string[] = [];
      let currentLineText = "";
      let lastY = -1;
      
      for (const item of items) {
        if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 4) {
          pageLines.push(currentLineText.trim());
          currentLineText = "";
        }
        currentLineText += item.str + " ";
        lastY = item.transform[5];
      }
      if (currentLineText) pageLines.push(currentLineText.trim());

      const cleanPageText = pageLines.join("\n").replace(/\s+/g, ' ').trim();
        
      if (cleanPageText.length > 5) {
        fullText += `--- START PAGE ${i} ---\n${cleanPageText}\n--- END PAGE ${i} ---\n\n`;
      }
    }

    const finalContent = fullText.trim();
    
    // 2. SCANNED PDF DETECTION
    // If we have pages but extracted almost zero text, it's a scanned image.
    if (!finalContent || finalContent.length < (pdf.numPages * 5)) {
      throw new Error(
        "Scanned PDF Detected: This file contains images instead of text. " +
        "Murshid AI needs a 'searchable' PDF to extract knowledge. " +
        "Please try a textbook that allows you to highlight text."
      );
    }

    return `PRIMARY TEXTBOOK CONTEXT (PAGES 1-${pageLimit}):\n\n${finalContent}`;
    
  } catch (error: any) {
    console.error("Murshid Extraction Core Error:", error);
    
    // User-friendly error re-mapping
    if (error.message.includes("Scanned") || error.message.includes("Password")) {
      throw error;
    }
    
    if (error.name === "InvalidPDFException" || error.message.includes("format")) {
      throw new Error("Invalid PDF: The file structure is broken. Try saving the PDF again or using a different file.");
    }
    
    throw new Error(`Textbook Error: ${error.message || "Failed to parse content. Please try a different PDF."}`);
  }
};
