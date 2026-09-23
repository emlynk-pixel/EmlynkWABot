//OCR Settings 

import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";
//Minimun usabble text length

const MIN_TEXT_LENGTH = 30;

// PDF file ekakin embedded/selectable text extract karanawa

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

// Image file ekak OCR karala text extract karanawa


export async function extractTextFromImage(fileBuffer){
    const worker = await createWorker("eng");

    try{

        const result = await worker.recognize(fileBuffer);
        const text = result.data.text?.trim() || " "; //pdf eke text nattam ethakota use karanwa

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


//Correct text extraction according to MIME Type

export async function extractDocumentText({
    fileBuffer,
    mimeType,
}){

    if(mimeType === "application/pdf"){

        const pdfResult = await extractTextFromPdf(fileBuffer);

        if(pdfResult.success){
            return pdfResult;
        }

        return {
            success: false,
            text: "",
            mmethod: "SCANNED_PDF_OCR_REQUIRED",
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