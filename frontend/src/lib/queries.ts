import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, apiStream, upload } from "./api"
import type { Board, BoardReport } from "./whiteboard"
import { useAuth } from "./auth"
import type {
  ActivityEntry, AttentionItem, Assignment, Capabilities, ChatMessage, Course, DashboardOverview, EvidenceEntry, FileInfo, LearningSignal, Material, ReviewQueueRow,
  RiskAssessment, Role, StudentDetailInfo, StudentRow, SubmissionRow,
} from "@/types"

const enc = encodeURIComponent

// ================================================================== shared
export function useCourses(role: Role) {
  const { status } = useAuth()
  return useQuery({
    queryKey: [role, "courses"],
    enabled: status === "ready",
    queryFn: async () => (await api<{ courses: Course[] }>(`/${role}/courses`)).courses,
  })
}

export function useCapabilities(purpose: "MATERIAL" | "ASSIGNMENT_ATTACHMENT" | "SUBMISSION", role?: "PROMPT" | "SUPPORTING") {
  return useQuery({
    queryKey: ["capabilities", purpose, role],
    staleTime: 10 * 60_000,
    queryFn: () => api<Capabilities>(`/files/capabilities?purpose=${purpose}${role ? `&role=${role}` : ""}`),
  })
}

export async function downloadFile(fileId: string) {
  const link = await api<{ url: string; filename: string }>(`/files/${enc(fileId)}/download-link`, { method: "POST" })
  window.open(link.url, "_blank", "noopener")
}

export interface Universities { universities: { id: string; name: string }[] }
export const fetchUniversities = () => api<Universities>("/universities", { auth: false })

// ================================================================== student
export const studentKeys = { all: ["student"] as const }

export function useStudentHome() {
  return useQuery({ queryKey: ["student", "home"], queryFn: () => api<{ user: { id: string; name: string }; courses: Course[]; assignments: Assignment[] }>("/student/home") })
}

export function useStudentCourse(courseId?: string) {
  return useQuery({
    queryKey: ["student", "course", courseId], enabled: !!courseId,
    queryFn: () => api<{ course: Course; materials: Material[]; assignments: Assignment[] }>(`/student/courses/${enc(courseId!)}`),
  })
}

export function useStudentMaterial(id?: string) {
  return useQuery({ queryKey: ["student", "material", id], enabled: !!id, queryFn: () => api<Material>(`/student/materials/${enc(id!)}`) })
}

export interface StudentAssignmentDetail extends Assignment {
  attempt: { id: string; attemptNumber: number; status: string; startedAt: string; draftText?: string | null } | null
  submission: { id: string; type: string; submittedAt: string; filename?: string | null } | null
  verification: { id: string; status: string; outcome?: string | null } | null
  grade: Grade | null
}

/** The one persisted grade: the teacher review page and the student's assignment page both render exactly this. */
export interface Grade { score: number; maxScore: number; percentage: number; feedback: string | null; gradedAt: string; gradedBy: string | null }

export function useStudentAssignment(id?: string) {
  return useQuery({ queryKey: ["student", "assignment", id], enabled: !!id, queryFn: () => api<StudentAssignmentDetail>(`/student/assignments/${enc(id!)}`) })
}

export function useJoinCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api<Course>("/student/courses/join", { method: "POST", body: { code } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }).then(() => qc.invalidateQueries({ queryKey: ["student", "courses"] })),
  })
}

export function useStartAttempt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (assignmentId: string) => api<{ id: string }>(`/student/assignments/${enc(assignmentId)}/attempts`, { method: "POST" }),
    onSuccess: (_d, assignmentId) => qc.invalidateQueries({ queryKey: ["student", "assignment", assignmentId] }),
  })
}

export interface SubmitResult { submissionId: string; textExtracted?: boolean; warning?: string; file?: FileInfo }

export function useSubmitFile(assignmentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ attemptId, file, onProgress }: { attemptId: string; file: File; onProgress?: (p: number) => void }) => {
      const form = new FormData()
      form.append("file", file)
      return upload<SubmitResult>(`/student/attempts/${enc(attemptId)}/submit-file`, form, onProgress)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }),
    meta: { assignmentId },
  })
}

export function useCoachHistory(assignmentId?: string) {
  return useQuery({
    queryKey: ["student", "coach", assignmentId], enabled: !!assignmentId,
    queryFn: async () => (await api<{ messages: ChatMessage[] }>(`/student/assignments/${enc(assignmentId!)}/coach`)).messages,
  })
}

export interface CoachReply {
  interactionId: string
  turn: number
  message: ChatMessage
  sources: { documentTitle?: string; pageNumber?: number; section?: string }[]
  /** present only when the Coach wrote on the board (or a board command ran): the board AS STORED after the turn + what was applied/rejected */
  board?: Partial<Board> & { report: BoardReport }
}
export interface CoachSend { assignmentId: string; message: string; mode?: "chat" | "board"; selectedId?: string | null; boardIntent?: string }
/** Streaming turn (same server logic as /ai/coach). `onStage` receives real pipeline steps. */
export function sendCoachStream(v: CoachSend, onStage: (label: string) => void, signal?: AbortSignal) {
  const body: Record<string, unknown> = { assignment_id: v.assignmentId, message: v.message, mode: v.mode ?? "chat" }
  if (v.selectedId) body.selected_id = v.selectedId
  if (v.boardIntent) body.board_intent = v.boardIntent
  return apiStream<CoachReply>("/ai/coach/stream", body, (label) => onStage(label), signal)
}
export function useSendCoach() {
  return useMutation({ mutationFn: (v: { assignmentId: string; message: string }) => api<CoachReply>("/ai/coach", { method: "POST", body: { assignment_id: v.assignmentId, message: v.message } }) })
}

export interface VerificationState {
  verificationId: string
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED"
  outcome?: string | null
  steps: { type: "EXPLAIN" | "MODIFY" | "TRANSFER"; status: "done" | "current" | "upcoming" }[]
  current: { questionId: string; type: string; question: string; index: number } | null
  needsQuestion: boolean
}
export function useStartVerification() {
  return useMutation({ mutationFn: (assignmentId: string) => api<VerificationState>(`/student/assignments/${enc(assignmentId)}/verification`, { method: "POST" }) })
}
export function useAnswerVerification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { verificationId: string; answer: string }) =>
      api<{ result: { outcome: string; feedback: string }; completed: boolean; state: VerificationState }>(`/student/verification/${enc(v.verificationId)}/response`, { method: "POST", body: { answer: v.answer } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }),
  })
}

// ================================================================== teacher
export function useTeacherCourse(courseId?: string) {
  return useQuery({
    queryKey: ["teacher", "course", courseId], enabled: !!courseId,
    // materials are still being processed -> poll until every file has settled
    refetchInterval: (q) => (q.state.data?.materials.some((m) => m.file && ["QUEUED", "PROCESSING"].includes(m.file.status)) ? 2500 : false),
    queryFn: () => api<{ course: Course; classrooms: { id: string; name: string; joinCode: string; joinEnabled: boolean }[]; materials: Material[];
      assignments: (Assignment & { submittedCount: number; studentCount: number })[] }>(`/teacher/courses/${enc(courseId!)}`),
  })
}

function attentionTo(courseId: string, t: { type: string; assignmentId?: string; studentId?: string }): string {
  if (t.type === "submission") return `/teacher/courses/${courseId}/assignments/${t.assignmentId}/submissions/${t.studentId}`
  if (t.type === "student") return `/teacher/students/${t.studentId}`
  return `/teacher/courses/${courseId}/assignments/${t.assignmentId}`
}

export interface Dashboard {
  course: Course
  overview: DashboardOverview
  reviewQueue: ReviewQueueRow[]
  riskDisclaimer: string
  metrics: { assignmentCompletion: number; averageGrade: number | null; socraticAiUsage: number; observedSignalRate: number; verificationRate: number }
  students: StudentRow[]
  attention: AttentionItem[]
  activity: ActivityEntry[]
}
export function useDashboard(courseId?: string) {
  return useQuery({
    queryKey: ["teacher", "dashboard", courseId], enabled: !!courseId,
    queryFn: async (): Promise<Dashboard> => {
      const d = await api<Omit<Dashboard, "attention"> & { attention: (Omit<AttentionItem, "to"> & { target: { type: string; assignmentId?: string; studentId?: string } })[] }>(`/teacher/courses/${enc(courseId!)}/dashboard`)
      return { ...d, attention: d.attention.map(({ target, ...a }) => ({ ...a, to: attentionTo(courseId!, target) })) }
    },
  })
}

export function useTeacherStudent(studentId?: string) {
  return useQuery({ queryKey: ["teacher", "student", studentId], enabled: !!studentId, queryFn: () => api<StudentDetailInfo>(`/teacher/students/${enc(studentId!)}`) })
}

export interface TeacherAssignmentDetail extends Assignment {
  submissions: SubmissionRow[]
  linkedMaterials: { id: string; title: string }[]
  concepts: string[]
  counts: { students: number; submitted: number; verified: number }
}
export function useTeacherAssignment(id?: string) {
  return useQuery({
    queryKey: ["teacher", "assignment", id], enabled: !!id,
    refetchInterval: (q) => (q.state.data?.attachments?.some((a) => ["QUEUED", "PROCESSING"].includes(a.status)) ? 2500 : false),
    queryFn: () => api<TeacherAssignmentDetail>(`/teacher/assignments/${enc(id!)}`),
  })
}

export interface SubmissionReviewData {
  assignment: { id: string; title: string; version: number }
  student: { id: string; name: string; email: string }
  attempt: { id: string; number: number; status: string; assignmentVersion: number } | null
  submission: { id: string; type: string; submittedAt: string; textPreview: string; textTruncated: boolean; file: FileInfo | null } | null
  verification: { id: string; status: string; outcome?: string | null; entries: (EvidenceEntry & { outcome?: string | null; feedback?: string | null })[] } | null
  grade: Grade | null
  whiteboard: Partial<Board> | null
  coachInteractions: number
  signals: LearningSignal[]
  signalsNote: string
  risk: RiskAssessment
}
export function useSubmissionReview(assignmentId?: string, studentId?: string) {
  return useQuery({
    queryKey: ["teacher", "review", assignmentId, studentId], enabled: !!assignmentId && !!studentId,
    queryFn: () => api<SubmissionReviewData>(`/teacher/assignments/${enc(assignmentId!)}/students/${enc(studentId!)}`),
  })
}

export function useSetGrade(assignmentId: string, studentId: string) {
  const qc = useQueryClient()
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ["teacher"] }), qc.invalidateQueries({ queryKey: ["student", "assignment", assignmentId] })])
  const base = `/teacher/assignments/${enc(assignmentId)}/students/${enc(studentId)}/grade`
  return {
    save: useMutation({ mutationFn: (v: { score: number; maxScore: number; feedback: string }) => api<{ grade: Grade }>(base, { method: "PUT", body: { score: v.score, max_score: v.maxScore, feedback: v.feedback || null } }), onSuccess: done }),
    clear: useMutation({ mutationFn: () => api<{ grade: null }>(base, { method: "DELETE" }), onSuccess: done }),
  }
}

export function useTeacherMaterial(id?: string) {
  return useQuery({
    queryKey: ["teacher", "material", id], enabled: !!id,
    refetchInterval: (q) => (q.state.data?.file && ["QUEUED", "PROCESSING"].includes(q.state.data.file.status) ? 2000 : false),
    queryFn: () => api<Material>(`/teacher/materials/${enc(id!)}`),
  })
}

export function useCreateCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { code: string; title: string; description: string; color: string }) => api<Course>("/teacher/courses", { method: "POST", body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useUploadMaterial(courseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, title, onProgress }: { file: File; title?: string; onProgress?: (p: number) => void }) => {
      const form = new FormData()
      form.append("file", file)
      if (title) form.append("title", title)
      return upload<Material>(`/teacher/courses/${enc(courseId)}/materials`, form, onProgress)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useMaterialActions(courseId: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ["teacher"] })
  return {
    retry: useMutation({ mutationFn: (id: string) => api<Material>(`/teacher/materials/${enc(id)}/retry`, { method: "POST" }), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/teacher/materials/${enc(id)}`, { method: "DELETE" }), onSuccess: done }),
    courseId,
  }
}

export interface NewAssignmentInput { title: string; topic?: string; prompt: string; dueAt?: string | null; publish: boolean }
export function useCreateAssignment(courseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { input: NewAssignmentInput; file?: File | null; onProgress?: (p: number) => void }) => {
      if (v.file) {
        const form = new FormData()
        form.append("file", v.file)
        form.append("title", v.input.title)
        if (v.input.topic) form.append("topic", v.input.topic)
        if (v.input.dueAt) form.append("due_at", v.input.dueAt)
        form.append("publish", String(v.input.publish))
        return upload<Assignment>(`/teacher/courses/${enc(courseId)}/assignments/upload`, form, v.onProgress)
      }
      return api<Assignment>(`/teacher/courses/${enc(courseId)}/assignments`, {
        method: "POST", body: { title: v.input.title, topic: v.input.topic || null, prompt: v.input.prompt, due_at: v.input.dueAt || null, publish: v.input.publish },
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useAssignmentActions(assignmentId: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ["teacher"] })
  const post = (action: string) => () => api<Assignment>(`/teacher/assignments/${enc(assignmentId)}/${action}`, { method: "POST" })
  return {
    publish: useMutation({ mutationFn: post("publish"), onSuccess: done }),
    unpublish: useMutation({ mutationFn: post("unpublish"), onSuccess: done }),
    archive: useMutation({ mutationFn: post("archive"), onSuccess: done }),
    attach: useMutation({
      mutationFn: ({ file, onProgress }: { file: File; onProgress?: (p: number) => void }) => {
        const form = new FormData()
        form.append("file", file)
        return upload<FileInfo>(`/teacher/assignments/${enc(assignmentId)}/attachments`, form, onProgress)
      }, onSuccess: done,
    }),
    detach: useMutation({ mutationFn: (attachmentId: string) => api<void>(`/teacher/assignments/${enc(assignmentId)}/attachments/${enc(attachmentId)}`, { method: "DELETE" }), onSuccess: done }),
  }
}

export function useRotateJoinCode() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (classroomId: string) => api<{ joinCode: string }>(`/teacher/classrooms/${enc(classroomId)}/join-code/rotate`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }) })
}


/** Thinking space of the student's open attempt. The save is the whole board (debounced by the caller). */
export function useWhiteboard(assignmentId?: string) {
  // gcTime 0: the board is edited by the student AND by the Coach, so a cached copy would be stale when the page is opened again.
  return useQuery({ queryKey: ["student", "whiteboard", assignmentId], enabled: !!assignmentId, staleTime: Infinity, gcTime: 0,
    queryFn: () => api<Partial<Board> & { updatedAt: string | null }>(`/student/assignments/${enc(assignmentId!)}/whiteboard`) })
}
/** `wire` is the snake_case body produced by `toWire` (the server schema is snake_case). */
/** Save the native board. Sends ONLY the scene: the server keeps the legacy fields exactly as stored. */
export const saveScene = (assignmentId: string, scene: unknown) =>
  api<Partial<Board> & { updatedAt: string }>(`/student/assignments/${enc(assignmentId)}/whiteboard`, { method: "PUT", body: { scene } })

export interface DiagramRequest { request: string; board: { id: string; text: string }[]; selectedId?: string | null }
/** Stage 1-2 of the drawing pipeline: a server-validated, coordinate-free diagram specification. */
export const generateDiagram = (body: DiagramRequest) =>
  api<{ spec: unknown; attempts: number }>(`/smartboard/generate-diagram`, { method: "POST", body: { request: body.request, board: body.board, selected_id: body.selectedId ?? null } })

export const saveWhiteboard = (assignmentId: string, wire: unknown) =>
  api<Partial<Board> & { updatedAt: string }>(`/student/assignments/${enc(assignmentId)}/whiteboard`, { method: "PUT", body: wire })
