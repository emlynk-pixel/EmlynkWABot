// Lucide, the EMLYNK design system's only icon set. Screens name an icon by
// what it means here, so changing a glyph touches this file alone.
import {
    ArrowUpFromLine, Bell, BellRing, Briefcase, Building2, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, CircleAlert, CircleCheck, CircleCheckBig, CircleX,
    ClipboardCheck, ClipboardList, ClipboardX, Clock, Eye, EyeOff, FileDown, FileText, FileUp, Flag, Headset, History, LayoutDashboard, LoaderCircle, Lock, LogOut,
    Mail, Moon, NotebookPen, PanelLeft, Pencil, Phone, PhoneMissed, RefreshCw, RotateCcw, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Sun, Trash2, UserCheck, UserCog, UserPlus,
    Users, UserSearch, X, type LucideIcon,
} from "lucide-react";

const ICONS = {
    assignment_late: ClipboardX,
    call: Phone,
    cancel: CircleX,
    check: Check,
    close: X,
    filter: SlidersHorizontal,
    picture_as_pdf: FileDown,
    upload: ArrowUpFromLine,
    check_circle: CircleCheck,
    dark_mode: Moon,
    delete: Trash2,
    edit: Pencil,
    event: Calendar,
    flag: Flag,
    flag_fill: Flag,
    edit_note: NotebookPen,
    phone_missed: PhoneMissed,
    task_alt: CircleCheckBig,
    upload_file: FileUp,
    light_mode: Sun,
    person_add: UserPlus,
    person_search: UserSearch,
    assignment_ind: UserCheck,
    work: Briefcase,
    support_agent: Headset,
    apartment: Building2,
    refresh: RotateCcw,
    schedule: Clock,
    search: Search,
    send: Send,
    summarize: ClipboardList,
    sync: RefreshCw,
    chevron_left: ChevronLeft,
    chevron_right: ChevronRight,
    dashboard: LayoutDashboard,
    description: FileText,
    error: CircleAlert,
    fact_check: ClipboardCheck,
    group: Users,
    manage_accounts: UserCog,
    history: History,
    local_police: ShieldCheck,
    lock: Lock,
    logout: LogOut,
    mail: Mail,
    panel_left: PanelLeft,
    progress_activity: LoaderCircle,
    settings: Settings,
    visibility: Eye,
    visibility_off: EyeOff,
    notifications: Bell,
    notifications_active: BellRing,
    keyboard_arrow_up: ChevronUp,
    keyboard_arrow_down: ChevronDown,
    unfold_more: ChevronsUpDown,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
    const Glyph = ICONS[name];
    return <Glyph aria-hidden="true" className={`icon inline-block shrink-0 ${name === "flag_fill" ? "fill-current" : ""} ${className}`} />;
}
