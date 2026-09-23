//Keep procssed ID in memory ( temporary )

const processedMessageIds = new Set();

//Check msg ID Lready processsed

export function isMessageProcessed(messageId){
    return processedMessageIds.has(messageId);
}



//Keep successfully processed IDs

export function markMessageAsProcessed(messageId){
    processedMessageIds.add(messageId);
}
