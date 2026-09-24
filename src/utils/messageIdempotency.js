// In-memory only: cleared on restart and not shared between instances.
// To be replaced by a database-backed check later.
const processedMessageIds = new Set();

export function isMessageProcessed(messageId){
    return processedMessageIds.has(messageId);
}

export function markMessageAsProcessed(messageId){
    processedMessageIds.add(messageId);
}
