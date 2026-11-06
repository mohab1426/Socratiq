/** The 'Ask SocratiQ' board actions: each sends a normal Coach turn with a board intent (the Coach decides what to say and write). */
export type BoardIntent = "explain" | "continue" | "correct" | "summarize" | "organize" | "highlight_key" | "steps"

export const ASK_ACTIONS: { intent: BoardIntent; label: string; message: (hasSelection: boolean) => string }[] = [
  { intent: "explain", label: "Explain this", message: (sel) => (sel ? "Explain the selected part of the board." : "Explain what is on the board.") },
  { intent: "continue", label: "Continue", message: () => "Continue from the last step on the board." },
  { intent: "correct", label: "Check my work", message: () => "Check my work on the board and tell me where to look." },
  { intent: "summarize", label: "Summarize", message: () => "Summarize the key points on the board." },
  { intent: "organize", label: "Organize the board", message: () => "Organize the board." },
  { intent: "highlight_key", label: "Highlight the key point", message: () => "Highlight the most important part of the board." },
  { intent: "steps", label: "Turn into steps", message: () => "Turn what is on the board into clear steps." },
]

