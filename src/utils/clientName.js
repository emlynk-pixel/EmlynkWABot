// Display name of a client. Legacy columns: first_name holds the given
// names, other_name the surname.
export function clientName(user) {
    return [user?.firstName, user?.otherName].filter(Boolean).join(" ").trim() || null;
}
