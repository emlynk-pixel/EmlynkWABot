// Quick first guess from the filename. It's only a hint: users often send
// files with random names, so content-based classification has the final say.

// Checked in order. The first match wins.
const FILENAME_RULES = [
    { documentType: "PASSPORT", keywords: ["passport", "travel document"] },
    { documentType: "MEDICAL", keywords: ["medical", "health"] },
    { documentType: "POLICE_REPORT", keywords: ["police", "clearance"] },
];

const FILENAME_MATCH_CONFIDENCE = 50;

export function classifyDocument({ fileName }) {
    if (fileName) {
        const normalizedFileName = fileName.toLowerCase();

        const rule = FILENAME_RULES.find(({ keywords }) =>
            keywords.some((keyword) => normalizedFileName.includes(keyword))
        );

        if (rule) {
            return {
                documentType: rule.documentType,
                confidence: FILENAME_MATCH_CONFIDENCE,
                source: "FILENAME",
            };
        }
    }

    return {
        documentType: "UNKNOWN",
        confidence: 0,
        source: "FILENAME",
    };
}
