/* One icon set, so the interface never falls back on emoji.
 *
 * Lucide, named here in our own words, so swapping the set means changing
 * this table and nothing else. Every icon inherits the current text colour. */
import {
  Activity, ArrowLeft, ArrowRight, AtSign, Award, BadgeCheck, BellRing, BookOpen, Bot, Brain, Briefcase, Bug, Building2, Calendar, Check,
  ChevronRight, CircleCheck, CircleX, ClipboardCheck, Clock, Coins, Copy, Cpu, Database, DoorOpen, Edit3, ExternalLink, Eye, FileSpreadsheet, FileText,
  Footprints, Gauge, GitBranch, GraduationCap, Handshake, Inbox, Layers, Lightbulb, Link2, LoaderCircle, Mail, MapPin, Maximize2, MessageSquare, Minimize2, Moon, Phone, PhoneCall, Play, Plus,
  ChartColumn, Download, LocateFixed, PanelLeftClose, PanelLeftOpen, RotateCw, ZoomIn, ZoomOut,
  PanelRight, PanelRightClose, Pause, Plug, QrCode, Radio, Receipt, RefreshCw, RotateCcw, Save, ScanLine, ScanSearch, Search, Send, ShieldAlert, ShieldCheck, Sliders, Stamp, Sun,
  Tag, Terminal, Timer, Trash2, TrendingDown, TrendingUp, TriangleAlert, Upload, UserRound, Users, Video, Volume2, Wallet, Webhook, Wifi, WifiOff, Wrench, X, Zap,
  Circle, FlaskConical, ListChecks, Settings2, Target,
  type LucideProps,
} from 'lucide-react';

const ICONS = {
  activity: Activity, arrowLeft: ArrowLeft, arrowRight: ArrowRight, at: AtSign, award: Award, badgeCheck: BadgeCheck, bell: BellRing, book: BookOpen, bot: Terminal,
  brain: Cpu, briefcase: Briefcase, bug: Bug, building: Building2, calendar: Calendar, check: Check, chevronRight: ChevronRight,
  ok: CircleCheck, fail: CircleX, clipboard: ClipboardCheck, clock: Clock, coins: Coins, copy: Copy, cpu: Cpu, database: Database,
  door: DoorOpen, edit: Edit3, external: ExternalLink, eye: Eye, sheet: FileSpreadsheet, file: FileText, footprints: Footprints, gauge: Gauge, flow: GitBranch, graduation: GraduationCap,
  handshake: Handshake, inbox: Inbox, layers: Layers, idea: Lightbulb, link: Link2, spinner: LoaderCircle, mail: Mail, pin: MapPin, expand: Maximize2, chat: MessageSquare, shrink: Minimize2,
  chart: ChartColumn, download: Download, locate: LocateFixed, foldL: PanelLeftClose, unfoldL: PanelLeftOpen, rotL: RotateCcw, rotR: RotateCw, zoomIn: ZoomIn, zoomOut: ZoomOut,
  moon: Moon, panel: PanelRight, panelOff: PanelRightClose, pause: Pause, phone: Phone, phoneCall: PhoneCall, play: Play, plus: Plus, plug: Plug, qr: QrCode, radio: Radio, receipt: Receipt, refresh: RefreshCw, reset: RotateCcw, save: Save, scan: ScanLine,
  scanSearch: ScanSearch, search: Search, send: Send, shieldAlert: ShieldAlert, shield: ShieldCheck, sliders: Sliders, stamp: Stamp,
  sun: Sun, tag: Tag, terminal: Terminal, timer: Timer, trash: Trash2, down: TrendingDown, up: TrendingUp, warn: TriangleAlert, upload: Upload, user: UserRound, users: Users, volume: Volume2, wallet: Wallet,
  webhook: Webhook, wifi: Wifi, wifiOff: WifiOff, video: Video, wrench: Wrench, x: X, zap: Zap,
  circle: Circle, flask: FlaskConical, list: ListChecks, gear: Settings2, target: Target,
} as const;

export type IconName = keyof typeof ICONS;

export default function Icon({ name, size = 16, strokeWidth = 2, className, style, ...rest }: { name: IconName } & LucideProps) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={strokeWidth} className={className} style={style} aria-hidden="true" {...rest} />;
}
