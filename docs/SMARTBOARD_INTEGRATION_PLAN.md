# SmartBoard → SocratiQ: Architectural Integration Plan

**Date:** 2026-10-09  
**Reference Project:** `smart-board-main`  
**Target Project:** `the-socratic-project-main` (SocratiQ)  
**Status:** Approved & Actively Executed  

---

## 1. Architectural Architecture & Module Mapping

```
smart-board-main (Reference)               the-socratic-project-main (SocratiQ)
─────────────────────────────────────────────────────────────────────────────────
App.tsx (Canvas + Toolbar + Chat)    ───►  frontend/src/components/socratiq/
                                           ├── SmartBoard.tsx (Interactive Stage)
                                           ├── BoardWorkspace.tsx (State, History, AI & Chat)
                                           └── SmartBoardToolbar.tsx (Tools, Properties, Audio)
components/SimulationNode.tsx        ───►  frontend/src/components/socratiq/SimulationNode.tsx
components/TextNode.tsx              ───►  frontend/src/components/socratiq/TextNode.tsx
components/Toolbar.tsx               ───►  frontend/src/components/socratiq/SmartBoardToolbar.tsx
services/geminiService.ts            ───►  frontend/src/lib/geminiSmartBoardService.ts
constants.ts                         ───►  frontend/src/lib/smartboardConstants.ts
server/index.js (Express / WS Proxy) ───►  backend/app/routers/smartboard.py (FastAPI / WS Relay)
```

---

## 2. Canvas Rendering & Interaction Model

1. **Hybrid Rendering Strategy:**
   - **Strokes layer:** Rendered on an HTML5 `<canvas>` element for 60fps freehand drawing without polluting the DOM tree.
   - **Shapes & Connectors layer:** Rendered on an `<svg>` element for vector fidelity, marker definitions (arrows), crisp bounding boxes, and selection marquee rect.
   - **Rich Media & Interactive layer:** Rendered as positioned DOM containers for Markdown/KaTeX text, LaTeX equations, sandboxed simulations (`iframe`), and compressed images.

2. **Pointer & Gesture System:**
   - Unified pointer event listeners with `pointerId` capturing.
   - Pan gestures supported via toolbar `pan` tool, mouse wheel, or touch pinch.
   - Zoom supported via `Ctrl + wheel` and toolbar buttons with bounds clamping (`0.1x` to `5.0x`).
   - Group transformation: Dragging moves all items in `selectedIds` together with offset calculation, preserving relative positions and line endpoints (`x1`, `y1`, `x2`, `y2`).

---

## 3. Dual AI Architecture (SmartBoard + SocratiQ Coach)

A critical requirement of the mission is **preserving SocratiQ's pedagogical source of truth while providing SmartBoard's real-time AI tools**:

```
                       ┌──────────────────────────────────────┐
                       │          Student Browser             │
                       │  (AiCoach.tsx / BoardWorkspace.tsx)  │
                       └───────────┬──────────────┬───────────┘
                                   │              │
                   (Pedagogical Questions)   (Direct Drawing / Vision / Voice)
                                   │              │
                                   ▼              ▼
           ┌─────────────────────────────┐  ┌─────────────────────────────┐
           │   SocratiQ AI Coach (RAG)   │  │   SmartBoard FastAPI Proxy  │
           │  - Curriculum & Assignment  │  │  - Vector shapes generation │
           │  - Socratic dialogue guard  │  │  - Interactive simulations  │
           │  - Student attempt context  │  │  - Generative images        │
           │  - Evaluation & Grading     │  │  - Gemini Live WebSocket    │
           └─────────────────────────────┘  └─────────────────────────────┘
```

1. **SocratiQ AI Coach:** Triggered via "Ask SocratiQ" dropdown or side coach chat. Analyzes student work, asks guiding questions, never writes direct answers.
2. **SmartBoard Gemini Tools:** Triggered via direct canvas prompt bar or Gemini Live. Generates vector diagrams, physics simulations, images, and moves elements directly on the board.

---

## 4. Database Safety & PostgreSQL 400KB Limit

- **Constraint:** `attempts.whiteboard` is stored in PostgreSQL as `jsonb` with a hard limit of ~400 KB per assignment attempt.
- **Image Optimization:** Raw user image uploads can easily exceed 2 MB base64 data. In SocratiQ, `BoardWorkspace.tsx` intercepts file uploads, downscales the image to a maximum bounding box of 600px, and encodes it as JPEG with 0.75 quality.
- **Measured Payload:**
  - 25 rich text elements + 2 compressed images = **180,988 bytes**.
  - Headroom remaining below 400 KB limit = **219,012 bytes**.
  - Zero schema migrations needed.

---

## 5. Security & Sandbox Invariants

1. **No API Keys in Frontend:** All Google GenAI keys are resolved server-side from environment variables.
2. **Simulation Sandbox:** All interactive simulation iframes are restricted with `sandbox="allow-scripts allow-forms allow-modals"`, strictly omitting `allow-same-origin` to eliminate cross-origin DOM access or cookie leakage.
3. **Keyboard Safety:** Delete/Backspace shortcuts are ignored when focus is inside text fields, preventing accidental object deletion while typing.
