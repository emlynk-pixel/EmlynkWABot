// A phone number reduced to a form that is the same however it was typed, so two numbers can be
// compared: spaces, dashes, dots, brackets and "+" are dropped, then a leading "00" (international
// prefix) is removed. Sri Lankan numbers become their 9 national digits, whether written
// +94 77 123 4567, 0094771234567, 94771234567, 0771234567 or 771234567 (the WhatsApp number is
// stored without the "+"). Any other number is compared as its plain digits.
export function phoneKey(value: string): string {
    let digits = value.replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith("94")) return digits.slice(2);
    // "+94 077..." (the trunk 0 kept after the country code)
    if (digits.length === 12 && digits.startsWith("940")) return digits.slice(3);
    if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
    return digits;
}

// Whether two numbers are the same number (an empty one never matches).
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = phoneKey(a ?? "");
    const right = phoneKey(b ?? "");
    return left !== "" && left === right;
}
