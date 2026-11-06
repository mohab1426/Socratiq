export type Role = "student" | "teacher"

export interface User {
  id: string
  name: string
  email: string
  role: Role
}

export type Mastery = "Strong" | "Moderate" | "Weak"

export type FileStatus = "QUEUED" | "PROCESSING" | "READY" | "STORED_ONLY" | "FAILED"
export type IndexMode = "RAG" | "EXTRACT_ONLY" | "STORAGE_ONLY"

export interface FileInfo {
  fileId: string
  filename: string
  extension: string
  mimeType: string
  sizeBytes: number
  kind: "DOCUMENT" | "PRESENTATION" | "SPREADSHEET" | "TEXT" | "CODE" | "IMAGE"
  indexMode: IndexMode
  status: FileStatus
  note?: string | null
  error?: string | null
  pageCount?: number | null
  createdAt?: string
  attachmentId?: string
  role?: "PROMPT" | "SUPPORTING"
}

export interface Course {
  id: string
  code: string
  name: string
  description: string
  teacher: string
  status: "Active" | "Archived"
  color: "plum" | "slate" | "teal" | "clay"
  materialCount: number
  assignmentCount: number
  studentCount?: number
  classroomId?: string | null
  joinCode?: string
}

export interface Material {
  id: string
  courseId: string
  title: string
  summary: string
  kind: "reading" | "slides" | "video" | "dataset"
  file?: FileInfo | null
  createdAt?: string
}

export type AssignmentStatus = "not_started" | "in_progress" | "submitted" | "verified"

export type AiAssistMode = "guided" | "assisted" | "open"

export interface Assignment {
  id: string
  courseId: string
  title: string
  topic: string
  prompt: string
  /** Student progress. Present on student endpoints; instructors use `lifecycle` instead. */
  status?: AssignmentStatus
  dueDate: string | null
  aiMode?: AiAssistMode
  lifecycle?: "DRAFT" | "PUBLISHED" | "ARCHIVED"
  version?: number
  attachments?: FileInfo[]
}

export interface SubmissionRow {
  studentId: string
  studentName: string
  status: AssignmentStatus
  mastery: Mastery | null
  submittedAt?: string | null
}

export interface EvidenceEntry {
  label: string
  prompt: string
  answer: string
}

export interface ChatMessage {
  id: string
  role: "coach" | "student"
  content: string
  kind?: "hint" | "question" | "explanation" | null
}

export interface StudentRow {
  id: string
  name: string
  taskSubmission: number
  socraticAiUsage: number
  /** % of assignments with at least one OBSERVED review indicator. An observation, never a claim about what a student did. */
  observedSignalRate: number
  observedSignalCount?: number
  mastery: Mastery | null   // null = not enough verification evidence yet
  risk: RiskBrief
}

export type SignalTone = "neutral" | "watch" | "positive"

export interface LearningSignal {
  label: string
  detail: string
  tone: SignalTone
}

export interface ActivityEntry {
  id: string
  date: string
  courseId: string
  assignmentId?: string
  assignmentTitle: string
  kind: "submission" | "revision" | "verification" | "coach_session"
  detail: string
}

export interface StudentDetailInfo {
  id: string
  name: string
  email: string
  courseIds: string[]
  mastery: Mastery | null
  taskSubmission: number
  socraticAiUsage: number
  observedSignalRate: number
  attempts: number
  revisions: number
  strugglingTopics: string[]
  signals: LearningSignal[]
  activity: ActivityEntry[]
  risk: RiskAssessment
  lastActivityAt: string | null
  assignments: StudentAssignmentProgress[]
  aiUsage: AiUsage
  verification: StudentVerificationRun[]
  concepts: StudentConcept[]
  timeline: TimelineEntry[]
}

// ------------------------------------------------------------------ risk intelligence (mirrors backend/app/risk.py)
/** `insufficient` = not enough recorded activity to assess. It is never rounded down to `low`. */
export type RiskLevel = "low" | "moderate" | "high" | "insufficient"
export type RiskFocus = "work_pattern" | "verification" | "process" | "learning_difficulty"

export interface RiskEvidenceRef {
  source: "risk_signal" | "verification" | "submission"
  refId: string
  assignmentId: string | null
  at: string | null
  detail: string
  learningEventId: string | null
  mitigated: boolean
}

export interface RiskSignalGroup {
  signal: string
  label: string
  category: "work_pattern" | "verification" | "process"
  categoryLabel: string
  severity: "LOW" | "MEDIUM" | "HIGH"
  meaning: string
  count: number
  points: number
  mitigatedCount: number
  evidence: RiskEvidenceRef[]
}

/** Confidence describes the ASSESSMENT (how much evidence there is), never the likelihood of misconduct. */
export interface RiskAssessment {
  level: RiskLevel
  levelLabel: string
  score: number | null
  confidence: number
  confidenceLabel: "Low" | "Medium" | "High"
  evidenceCount: number
  activityUnits: number
  minActivityUnits: number
  topSignals: RiskSignalGroup[]
  reasons: string[]
  explanation: string
  primaryReason: string | null
  focus: RiskFocus | null
  mitigating: { assignmentsWithPassedVerification: number; strongPositiveEvidence: number }
  lastEvidenceAt: string | null
  disclaimer: string
  modelVersion: string
}

export interface RiskBrief {
  level: RiskLevel
  levelLabel: string
  score: number | null
  confidenceLabel: "Low" | "Medium" | "High"
  evidenceCount: number
  primaryReason: string | null
  focus: RiskFocus | null
  lastActivityAt: string | null
}

export interface ReviewQueueRow {
  studentId: string
  name: string
  /** risk_review = moderate/high review indicator; learning_support = weak verified mastery (a learning difficulty, not an AI question). */
  kind: "risk_review" | "learning_support"
  level: RiskLevel | null
  levelLabel: string | null
  primaryReason: string | null
  focus: RiskFocus | null
  evidenceCount: number | null
  confidenceLabel: "Low" | "Medium" | "High"
  lastActivityAt: string | null
  /** The assignment behind the strongest signal's latest evidence (risk_review only): where to start looking. */
  assignmentId: string | null
  assignmentTitle: string | null
}

export interface DashboardOverview {
  students: number
  activeStudents: number
  needsReview: number
  needsSupport: number
  assignments: number
  verificationsCompleted: number
  riskDistribution: Record<RiskLevel, number>
}

export interface StudentAssignmentProgress {
  assignmentId: string
  courseId: string
  title: string
  dueAt: string | null
  submitted: boolean
  verificationOutcome: string | null
  coachTurns: number
}

export interface AiUsage {
  interactions: number
  sessions: number
  firstAt: string | null
  lastAt: string | null
  byIntervention: { type: string; label: string; count: number }[]
  byDiagnosis: { type: string; label: string; count: number }[]
  perAssignment: { assignmentId: string; title: string; turns: number }[]
  notTracked?: string[]
}

export interface StudentVerificationRun {
  id: string
  assignmentId: string
  courseId: string
  assignmentTitle: string
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED"
  outcome: string | null
  score: number | null
  startedAt: string | null
  completedAt: string | null
  questions: { type: string; concept: string | null; outcome: string | null; feedback: string | null }[]
}

export interface StudentConcept {
  name: string
  level: Mastery | null
  mastery: number | null
  evidenceCount: number
  lastEvaluatedAt: string | null
  recentScores: number[]
  trend: "up" | "down" | "flat" | null
  assignments: { assignmentId: string; title: string }[]
  coachMentions: number
}

export interface TimelineEntry {
  id: string
  at: string | null
  kind: "attempt" | "coach" | "submission" | "revision" | "verification" | "other"
  label: string
  assignmentId: string | null
  assignmentTitle: string
  courseId: string
  flagged: boolean
  signals: string[]
}

export interface AttentionItem {
  id: string
  kind: "review" | "signal" | "deadline"
  title: string
  description: string
  to: string
  tone: "warning" | "danger" | "neutral"
}

export interface Capabilities {
  purpose: string
  extensions: string[]
  accept: string
  maxBytes: number
  formats: { extension: string; kind: string; label: string; mimeType: string; mode: IndexMode; maxBytes: number; note?: string | null }[]
}
