//Service functions for download Meta whatsapp media files

export async function getWhatsappMediaUrl(MediaId){

    //Checked Required Env

    if(!process.env.WHATSAPP_ACCESS_TOKEN){
        throw new Error("WHATSAPP_ACCESS_TOKEN not found in env variables");
    }

    if(!process.env.WHATSAPP_API_VERSION){
        throw new Error("WHATSAPP_API_VERSION not found in env variables");
    }

    const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${MediaId}`;

    //Send req to meta API

    const response = await fetch(url,{
        method: "GET",
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
    });


    //Handle meta req fail error

    if (!response.ok){
        const errorData = await response.text();

        throw new Error(
            `Failed to get Whatsapp media URL: ${response.status} - ${errorData}`
        );
    }

    //Get response JSON

    const data = await response.json();

    if(!data.url){
        throw new Error("Whatsapp media url not found");
    }
    return data.url;
}

//Download actual binary file content from media url

export async function downloadWhatsappMedia(mediaUrl){

    if (!process.env.WHATSAPP_ACCESS_TOKEN){
        throw new Error("WHATSAPP_ACCESS_TOKEN not found in env variables");
    }

    const response = await fetch(mediaUrl, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
    });


    // IF download req is fail 

    if (!response.ok){
        const errorData = await response.text();
        throw new Error(
            `Failed to download Whatsapp media: ${response.status} - ${errorData}`
        );

    }

    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    return fileBuffer;
}


    
    

    


