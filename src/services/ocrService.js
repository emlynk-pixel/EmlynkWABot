import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";

// Below this, a PDF is treated as scanned (image-only) rather than text-based.
const MIN_TEXT_LENGTH = 30;

// Read the embedded text layer of a PDF.
export async function extractTextFromPdf(fileBuffer){

    let parser;

    try{

        parser = new PDFParse({
            data: fileBuffer,
        });

        const result = await parser.getText();
        const text = result.text?.trim() || "";
        return {

            success: text.length >= MIN_TEXT_LENGTH,
            text,
            method: "PDF_TEXT",
        };

    }catch(error){
        console.error(
            "PDF text extraction failed:",
            error.message
        );

        return{
            success: false,
            text: "",
            method: "PDF_TEXT",
        };
    }

    finally {
        if(parser){
            await parser.destroy();
        }
    }
}

// Run Tesseract OCR on a JPEG/PNG image.
export async function extractTextFromImage(fileBuffer){
    const worker = await createWorker("eng");

    try{

        const result = await worker.recognize(fileBuffer);
        const text = result.data.text?.trim() || "";

        return{
            success: text.length > 0,
            text,
            method: "OCR",
            confidence: result.data.confidence || 0,
        };
    } finally {
        await worker.terminate();
    }
}


// Pick the extraction method based on MIME type.
export async function extractDocumentText({
    fileBuffer,
    mimeType,
}){

    if(mimeType === "application/pdf"){

        const pdfResult = await extractTextFromPdf(fileBuffer);

        if(pdfResult.success){
            return pdfResult;
        }

        // Scanned-PDF OCR isn't implemented yet. Flag it for later.
        return {
            success: false,
            text: "",
            method: "SCANNED_PDF_OCR_REQUIRED",
        };
    }

    if (
        mimeType === "image/jpeg" ||
        mimeType === "image/png"

    ){
        return await extractTextFromImage(fileBuffer);
    }

    return {

        success: false,
        text: "",
        method: "UNSUPPORTED_DOCUMENT_TYPE",
    };


}
