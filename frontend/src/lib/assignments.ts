import type { AssignmentStatus } from "@/types"

export const assignmentStatusLabel: Record<AssignmentStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  verified: "Verified",
}

/** Student has handed the work in (submitted or already verified), so its deadline is no longer a warning. */
export const isDone = (status?: AssignmentStatus) => status === "submitted" || status === "verified"
