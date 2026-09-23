import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

//Temp folder for save docs

const TEMP_DIRECTORY = path.join(

    process.cwd(),
    "storage",
    "temp"

);

//Save downloaded doc buffer in temp storage

export async function saveTemporaryFile({

    fileBuffer,
    originalFileName,
    mimeType,
}) {

    //Create temp dir if doesnt exits

    await fs.mkdir(TEMP_DIRECTORY, {
        recursive: true,
    });

    //Get extension from original file

    let extension = path.extname(originalFileName || "");

    if (!extension){
        if (mimeType === "application/pdf"){
            extension = ".pdf";
        }else if ( mimeType === "image/jpeg"){
            extension = ".jpeg";

        }else if ( mimeType === "image/png"){
            extension = ".png";
        }

    }



//Generate Unique temporary fileName

const storedFileName = `${crypto.randomUUID()}${extension}`;

const storagePath = path.join(
    TEMP_DIRECTORY,
    storedFileName
);



//Save the file buffer async without block execution

await fs.writeFile(
    storagePath,
    fileBuffer

);

return{
    storedFileName,
    storagePath,
};

}
