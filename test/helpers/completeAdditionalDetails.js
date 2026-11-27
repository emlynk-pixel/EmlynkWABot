// A candidate_additional_details row (Prisma data) with every field the Additional Details form
// shows filled: additionalDetailsComplete() holds for it. Both parents alive and married, so every
// conditional field is required too. Test data only.
export const completeAdditionalDetailsData = (extra = {}) => ({
    nameAsInPassport: "NIMAL PERERA", permanentAddress: "1 Main Street, Colombo", birthday: new Date("1990-01-01"),
    bloodGroup: "O+", height: "175 cm", weightKg: "72.5", drivingLicence: false, canReadDrawings: true, teamLeadingSkills: false,
    otherLanguages: "Tamil", englishKnowledge: "GOOD",
    email: "nimal@example.invalid", city: "Colombo", district: "Colombo", dsDivision: "Colombo", gnDivision: "Kollupitiya", cityInRomania: "Bucharest",
    tshirtSize: "L", pantSize: "32", shoeSize: "42",
    fatherAlive: true, fatherFullName: "SUNIL PERERA", fatherBirthday: new Date("1960-01-01"), fatherPassportNumber: "N1000001",
    motherAlive: true, motherFullName: "KAMALA PERERA", motherBirthday: new Date("1962-01-01"), motherPassportNumber: "N1000002",
    maritalStatus: "MARRIED", wifeFullName: "NILMINI PERERA", wifeBirthday: new Date("1992-01-01"), spousePassportNumber: "N1000003",
    otherJobSkills: "Welding", otherJobSkills2: "Painting", otherJobCategory: "Construction",
    guardianName: "SUNIL PERERA", guardianRelationship: "Father", guardianNic: "600000001V", guardianBirthday: new Date("1960-01-01"),
    guardianPhone: "94770000009", guardianAddress: "1 Main Street, Colombo",
    ...extra,
});
