import type { ReactNode } from "react";
import logo from "../assets/emops-on-dark.svg";

// Frame of every signed-out page: the logo above a card on the brand slate,
// with the product line below.
export function AuthShell({ children }: { children: ReactNode }) {
    return (
        <div className="flex min-h-full flex-col items-center justify-center gap-8 bg-sidebar px-4 py-12">
            <img src={logo} alt="EMOPS by EMLYNK" width={188} height={73} className="h-auto w-[188px] max-w-full" />
            <div className="w-full max-w-sm">{children}</div>
            <p className="text-label-sm text-sidebar-text-muted">EMOPS by EMLYNK · Recruitment operations</p>
        </div>
    );
}
