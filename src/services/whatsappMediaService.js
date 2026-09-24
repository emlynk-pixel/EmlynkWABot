// Fetch WhatsApp media from the Meta Graph API.

function getAuthHeaders() {
    if (!process.env.WHATSAPP_ACCESS_TOKEN) {
        throw new Error("WHATSAPP_ACCESS_TOKEN not found in env variables");
    }

    return {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    };
}

// Meta doesn't send the file itself, only a media ID. Exchange it for a short-lived download URL.
export async function getWhatsappMediaUrl(mediaId) {
    const headers = getAuthHeaders();

    if (!process.env.WHATSAPP_API_VERSION) {
        throw new Error("WHATSAPP_API_VERSION not found in env variables");
    }

    const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${mediaId}`;

    const response = await fetch(url, {
        method: "GET",
        headers,
    });

    if (!response.ok) {
        const errorData = await response.text();

        throw new Error(
            `Failed to get Whatsapp media URL: ${response.status} - ${errorData}`
        );
    }

    const data = await response.json();

    if (!data.url) {
        throw new Error("Whatsapp media url not found");
    }
    return data.url;
}

// The download URL also needs the access token.
export async function downloadWhatsappMedia(mediaUrl) {
    const headers = getAuthHeaders();

    const response = await fetch(mediaUrl, {
        method: "GET",
        headers,
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
            `Failed to download Whatsapp media: ${response.status} - ${errorData}`
        );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
