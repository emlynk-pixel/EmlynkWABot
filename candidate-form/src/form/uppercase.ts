// English free text is kept in capitals, like the passport and the staff
// records: "shamal sathsara" becomes "SHAMAL SATHSARA" in the form value
// itself (not just on screen).
//
// Only the Latin letters a-z change. Sinhala and every other script, digits,
// spaces and punctuation are left exactly as typed, and the length never
// changes, so the cursor can stay where it was. Email, phone numbers, dates
// and the choice lists are never passed through this.
//
// This is for the candidate's eyes only: the server normalises again when
// saving is connected (Task 3).
export function toUpperEnglish(value: string): string {
    return value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}
