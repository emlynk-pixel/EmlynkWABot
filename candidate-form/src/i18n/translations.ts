// Every piece of text the candidate reads, in English and Sinhala. Only the
// displayed words change with the language: form values, field names and
// anything sent to the server stay the same in both.
//
// English is the source of truth for the keys; the Sinhala dictionary is
// typed against it, so a missing or extra key fails the typecheck.
// "{name}" in a message is filled in by t(key, { name: value }).

export const LANGUAGES = ["en", "si"] as const;
export type Language = (typeof LANGUAGES)[number];

// Each language's own name, written in that language (the switch shows both).
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", si: "සිංහල" };

const en = {
    "app.subtitle": "Candidate Details",
    "steps.label": "Progress",
    "steps.verify": "Verify",
    "steps.details": "Your details",
    "required": "required",

    "notConfigured.title": "Not available",
    "notConfigured.lead": "This form is not configured yet. Please try again later.",

    "verify.title": "Verify your details",
    "verify.lead": "Enter the passport number and WhatsApp number you registered with.",
    "verify.passport": "Passport Number",
    "verify.passportHelp": "As printed on your passport: letters and numbers only.",
    "verify.whatsapp": "WhatsApp Number",
    "verify.whatsappHint": "Start with + and your country code, for example +94771234567.",
    "verify.submit": "Verify",
    "verify.submitting": "Verifying…",
    "verify.passportInvalid": "Enter your passport number using letters and numbers only.",
    "verify.whatsappInvalid": "Enter your WhatsApp number starting with + and your country code, for example +94771234567.",
    "verify.failed": "We couldn't verify your details. Please check your Passport Number and WhatsApp Number and try again.",
    "verify.invalidInput": "Please check the details you entered and try again.",
    "verify.rateLimited": "Too many attempts. Please wait a while and try again later.",
    "verify.unavailable": "This service is not available right now. Please try again later.",
    "error.network": "We couldn't reach the server. Please check your connection and try again.",
    "error.generic": "Something went wrong. Please try again later.",
    "session.ended": "Your session has ended. Please verify again to continue.",

    "details.title": "Additional details",
    "details.verified": "Your details were verified.",
    "details.lead": "Please fill in the details below. Fields marked * are required.",
    "details.saveNotice": "Saving is not available yet. Nothing you enter here is saved, and it is cleared when you leave this page.",
    "details.sessionEnds": "For your security, this session ends at {time}.",
    "details.unsaved": "You have changes that are not saved.",
    "details.save": "Save details",
    "details.finish": "Finish",
    "details.fixErrors": "Please correct the highlighted fields.",
    "details.checkPassed": "Your details look complete. Saving is not available yet, so nothing has been saved.",

    "section.personal": "Personal details",
    "section.sizes": "Clothing and shoe sizes",
    "section.father": "Father",
    "section.mother": "Mother",
    "section.family": "Marital status and family",
    "section.skills": "Other job skills",

    "field.nameAsInPassport": "Full name as in passport",
    "field.permanentAddress": "Permanent address",
    "field.birthday": "Date of birth",
    "field.tshirtSize": "T-shirt size",
    "field.pantSize": "Trouser waist size (inches)",
    "field.shoeSize": "Shoe size (UK)",
    "field.pantSizeOther": "Your trouser waist size",
    "field.shoeSizeOther": "Your shoe size",
    "field.fatherAlive": "Is your father alive?",
    "field.fatherFullName": "Father's full name",
    "field.fatherBirthday": "Father's date of birth",
    "field.motherAlive": "Is your mother alive?",
    "field.motherFullName": "Mother's full name",
    "field.motherBirthday": "Mother's date of birth",
    "field.maritalStatus": "Marital status",
    "field.wifeFullName": "Wife's full name",
    "field.wifeBirthday": "Wife's date of birth",
    "field.child1Name": "First child's name",
    "field.child2Name": "Second child's name",
    "field.child3Name": "Third child's name",
    "field.otherJobSkills": "Other job skills",

    "help.button": "Help: {field}",
    "help.nameAsInPassport": "Write your name exactly as it appears on your passport.",
    "help.pantSize": "Your waist measurement in inches. Choose Other if your size is not in the list.",
    "help.shoeSize": "Your UK shoe size. Choose Other if your size is not in the list.",
    "help.parentName": "Required if your parent is alive. You can also enter it if they have passed away.",
    "help.children": "Optional. Enter children in order, starting with the first.",
    "help.otherJobSkills": "For example: driving licence, welding, cooking, languages.",

    "option.select": "Select…",
    "option.other": "Other",
    "option.yes": "Yes",
    "option.no": "No",
    "marital.SINGLE": "Single",
    "marital.MARRIED": "Married",
    "marital.DIVORCED": "Divorced",
    "marital.WIDOWED": "Widowed",
    "marital.SEPARATED": "Separated",

    "v.required": "This field is required.",
    "v.dateInvalid": "Enter a valid date.",
    "v.dateFuture": "The date cannot be in the future.",
    "v.dateTooEarly": "The date cannot be before 1900.",
    "v.tooLong": "Use at most {max} characters.",
    "v.sizeInvalid": "Use up to 10 letters, numbers, spaces, dots, slashes or dashes.",
    "v.child2Order": "Enter the first child's name first.",
    "v.child3Order": "Enter the second child's name first.",
};

export type MessageKey = keyof typeof en;

const si: Record<MessageKey, string> = {
    "app.subtitle": "අපේක්ෂක විස්තර",
    "steps.label": "ප්‍රගතිය",
    "steps.verify": "තහවුරු කිරීම",
    "steps.details": "ඔබේ විස්තර",
    "required": "අනිවාර්යයි",

    "notConfigured.title": "ලබා ගත නොහැක",
    "notConfigured.lead": "මෙම පෝරමය තවම සකස් කර නැත. කරුණාකර පසුව නැවත උත්සාහ කරන්න.",

    "verify.title": "ඔබේ විස්තර තහවුරු කරන්න",
    "verify.lead": "ඔබ ලියාපදිංචි වූ විට ලබා දුන් ගමන් බලපත්‍ර අංකය සහ WhatsApp අංකය ඇතුළත් කරන්න.",
    "verify.passport": "ගමන් බලපත්‍ර අංකය",
    "verify.passportHelp": "ඔබේ ගමන් බලපත්‍රයේ සඳහන් පරිදි: අකුරු සහ ඉලක්කම් පමණි.",
    "verify.whatsapp": "WhatsApp අංකය",
    "verify.whatsappHint": "+ ලකුණ සහ රටේ කේතය සමඟ ආරම්භ කරන්න, උදාහරණයක් ලෙස +94771234567.",
    "verify.submit": "තහවුරු කරන්න",
    "verify.submitting": "තහවුරු කරමින්…",
    "verify.passportInvalid": "ඔබේ ගමන් බලපත්‍ර අංකය අකුරු සහ ඉලක්කම් පමණක් භාවිත කර ඇතුළත් කරන්න.",
    "verify.whatsappInvalid": "ඔබේ WhatsApp අංකය + ලකුණ සහ රටේ කේතය සමඟ ඇතුළත් කරන්න, උදාහරණයක් ලෙස +94771234567.",
    "verify.failed": "ඔබේ විස්තර තහවුරු කළ නොහැකි විය. කරුණාකර ඔබේ ගමන් බලපත්‍ර අංකය සහ WhatsApp අංකය පරීක්ෂා කර නැවත උත්සාහ කරන්න.",
    "verify.invalidInput": "කරුණාකර ඔබ ඇතුළත් කළ විස්තර පරීක්ෂා කර නැවත උත්සාහ කරන්න.",
    "verify.rateLimited": "උත්සාහයන් ඕනෑවට වඩා වැඩිය. කරුණාකර ටික වේලාවක් රැඳී සිට පසුව නැවත උත්සාහ කරන්න.",
    "verify.unavailable": "මෙම සේවාව මේ මොහොතේ ලබා ගත නොහැක. කරුණාකර පසුව නැවත උත්සාහ කරන්න.",
    "error.network": "සේවාදායකය හා සම්බන්ධ විය නොහැකි විය. කරුණාකර ඔබේ අන්තර්ජාල සම්බන්ධතාවය පරීක්ෂා කර නැවත උත්සාහ කරන්න.",
    "error.generic": "යම් දෝෂයක් සිදු විය. කරුණාකර පසුව නැවත උත්සාහ කරන්න.",
    "session.ended": "ඔබේ සැසිය අවසන් විය. ඉදිරියට යාමට කරුණාකර නැවත තහවුරු කරන්න.",

    "details.title": "අමතර විස්තර",
    "details.verified": "ඔබේ විස්තර තහවුරු කරන ලදී.",
    "details.lead": "කරුණාකර පහත විස්තර පුරවන්න. * ලකුණ ඇති කොටස් අනිවාර්ය වේ.",
    "details.saveNotice": "සුරැකීම තවම ලබා ගත නොහැක. ඔබ මෙහි ඇතුළත් කරන කිසිවක් සුරැකෙන්නේ නැති අතර, ඔබ මෙම පිටුවෙන් ඉවත් වූ විට එය මැකී යයි.",
    "details.sessionEnds": "ඔබේ ආරක්ෂාව සඳහා, මෙම සැසිය {time} ට අවසන් වේ.",
    "details.unsaved": "සුරැකී නැති වෙනස්කම් ඇත.",
    "details.save": "විස්තර සුරකින්න",
    "details.finish": "අවසන් කරන්න",
    "details.fixErrors": "කරුණාකර සලකුණු කර ඇති කොටස් නිවැරදි කරන්න.",
    "details.checkPassed": "ඔබේ විස්තර සම්පූර්ණ බව පෙනේ. සුරැකීම තවම ලබා ගත නොහැකි බැවින්, කිසිවක් සුරැකී නැත.",

    "section.personal": "පුද්ගලික විස්තර",
    "section.sizes": "ඇඳුම් සහ සපත්තු ප්‍රමාණ",
    "section.father": "පියා",
    "section.mother": "මව",
    "section.family": "විවාහක තත්ත්වය සහ පවුල",
    "section.skills": "වෙනත් රැකියා කුසලතා",

    "field.nameAsInPassport": "ගමන් බලපත්‍රයේ ඇති පරිදි සම්පූර්ණ නම",
    "field.permanentAddress": "ස්ථිර ලිපිනය",
    "field.birthday": "උපන් දිනය",
    "field.tshirtSize": "ටී-ෂර්ට් ප්‍රමාණය",
    "field.pantSize": "කලිසමේ ඉණ ප්‍රමාණය (අඟල්)",
    "field.shoeSize": "සපත්තු ප්‍රමාණය (UK)",
    "field.pantSizeOther": "ඔබේ කලිසමේ ඉණ ප්‍රමාණය",
    "field.shoeSizeOther": "ඔබේ සපත්තු ප්‍රමාණය",
    "field.fatherAlive": "ඔබේ පියා ජීවතුන් අතරද?",
    "field.fatherFullName": "පියාගේ සම්පූර්ණ නම",
    "field.fatherBirthday": "පියාගේ උපන් දිනය",
    "field.motherAlive": "ඔබේ මව ජීවතුන් අතරද?",
    "field.motherFullName": "මවගේ සම්පූර්ණ නම",
    "field.motherBirthday": "මවගේ උපන් දිනය",
    "field.maritalStatus": "විවාහක තත්ත්වය",
    "field.wifeFullName": "බිරිඳගේ සම්පූර්ණ නම",
    "field.wifeBirthday": "බිරිඳගේ උපන් දිනය",
    "field.child1Name": "පළමු දරුවාගේ නම",
    "field.child2Name": "දෙවන දරුවාගේ නම",
    "field.child3Name": "තෙවන දරුවාගේ නම",
    "field.otherJobSkills": "වෙනත් රැකියා කුසලතා",

    "help.button": "උදව්: {field}",
    "help.nameAsInPassport": "ඔබේ නම ගමන් බලපත්‍රයේ ඇති ආකාරයටම ලියන්න.",
    "help.pantSize": "ඔබේ ඉණ ප්‍රමාණය අඟල් වලින්. ඔබේ ප්‍රමාණය ලැයිස්තුවේ නැත්නම් \"වෙනත්\" තෝරන්න.",
    "help.shoeSize": "ඔබේ UK සපත්තු ප්‍රමාණය. ඔබේ ප්‍රමාණය ලැයිස්තුවේ නැත්නම් \"වෙනත්\" තෝරන්න.",
    "help.parentName": "ඔබේ දෙමාපියන් ජීවතුන් අතර නම් අනිවාර්ය වේ. ඔවුන් මිය ගොස් ඇත්නම් ද එය ඇතුළත් කළ හැක.",
    "help.children": "අනිවාර්ය නොවේ. පළමු දරුවාගෙන් පටන් ගෙන පිළිවෙලින් ඇතුළත් කරන්න.",
    "help.otherJobSkills": "උදාහරණ: රියදුරු බලපත්‍රය, වෑල්ඩින්, ආහාර පිසීම, භාෂා.",

    "option.select": "තෝරන්න…",
    "option.other": "වෙනත්",
    "option.yes": "ඔව්",
    "option.no": "නැත",
    "marital.SINGLE": "අවිවාහක",
    "marital.MARRIED": "විවාහක",
    "marital.DIVORCED": "දික්කසාද",
    "marital.WIDOWED": "වැන්දඹු",
    "marital.SEPARATED": "වෙන්ව සිටින",

    "v.required": "මෙම කොටස අනිවාර්ය වේ.",
    "v.dateInvalid": "වලංගු දිනයක් ඇතුළත් කරන්න.",
    "v.dateFuture": "දිනය අනාගත දිනයක් විය නොහැක.",
    "v.dateTooEarly": "දිනය 1900 ට පෙර විය නොහැක.",
    "v.tooLong": "උපරිම අක්ෂර {max} ක් භාවිත කරන්න.",
    "v.sizeInvalid": "අකුරු, ඉලක්කම්, හිස්තැන්, තිත්, ඇල ඉරි හෝ ඉරි 10 ක් දක්වා භාවිත කරන්න.",
    "v.child2Order": "පළමුව පළමු දරුවාගේ නම ඇතුළත් කරන්න.",
    "v.child3Order": "පළමුව දෙවන දරුවාගේ නම ඇතුළත් කරන්න.",
};

export const TRANSLATIONS: Record<Language, Record<MessageKey, string>> = { en, si };

export type MessageParams = Record<string, string | number>;

// The text of `key` in `language`, with {placeholders} filled in.
export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
    const text = TRANSLATIONS[language][key];
    return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
}
