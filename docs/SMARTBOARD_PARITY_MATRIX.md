# SmartBoard → SocratiQ: Feature-Parity Matrix

**Date:** 2026-10-09  
**Reference Project:** `smart-board-main`  
**Target Project:** `the-socratic-project-main` (SocratiQ)  
**Status Legend:**
- `IMPLEMENTED`: Code exists and is integrated into SocratiQ.
- `TESTED`: Verified with automated tests (Vitest or Pytest).
- `IN PROGRESS`: Active integration refinement.
- `BLOCKED`: Hardware or external constraint.

---

## 1. Canvas & Drawing Parity

| Feature ID | Specific Behavior | Reference File | SocratiQ Module | Parity Status | Test Suite & Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CAN-01** | Freehand pen continuous path drawing | `App.tsx:1027` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-02** | Stroke simplification & smoothing | `App.tsx:1098` | `lib/whiteboard.ts` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-03** | Highlighter semi-transparent stroke | `App.tsx:1027` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-04** | Destination-out freehand erasing | `App.tsx:1120` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-05** | Straight line drag creation (x1,y1 → x2,y2) | `App.tsx:1028` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-06** | Rectangle drag creation with corner radius | `App.tsx:1029` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-07** | Circle / Ellipse drag creation | `App.tsx:1029` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-08** | Triangle polygon creation | `App.tsx:1029` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-09** | Arrow endpoint linking / freeform creation | `App.tsx:301` | `SmartBoard.tsx` | `TESTED` | Pytest: `test_whiteboard_engine.py` |
| **CAN-10** | Text inline double-click editing | `App.tsx:988` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-11** | Text Markdown rendering | `TextNode.tsx` | `TextNode.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-12** | LaTeX equation modal with KaTeX preview | `MathView.tsx` | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **CAN-13** | Image file upload to canvas | `App.tsx:310` | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **CAN-14** | Client-side JPEG downscaling (400KB safe) | N/A (custom) | `BoardWorkspace.tsx` | `TESTED` | Python payload test (<181KB) |
| **CAN-15** | Interactive Simulation iframe container | `SimulationNode.tsx` | `SimulationNode.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **CAN-16** | Simulation Lock / Unlock mode toggle | `SimulationNode.tsx` | `SimulationNode.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |

---

## 2. Selection & Manipulation Parity

| Feature ID | Specific Behavior | Reference File | SocratiQ Module | Parity Status | Test Suite & Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEL-01** | Single element click selection & blue outline | `App.tsx:1002` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-02** | Shift-click multi-selection toggle | `App.tsx:1006` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-03** | Marquee drag selection box on empty canvas | `App.tsx:1018` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-04** | Group dragging without relative offset shifts | `App.tsx:1043` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-05** | Line endpoints translation in group drag | N/A (ref bug) | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-06** | Multi-element deletion via Delete / Backspace | `App.tsx:939` | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **SEL-07** | Keyboard deletion guard on active inputs | N/A (fix) | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **SEL-08** | Element resize handle (bottom-right) | `App.tsx:953` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-09** | Element rotate handle (top) | `App.tsx:975` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **SEL-10** | 15-degree rotation snapping with Shift key | `App.tsx:1079` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |

---

## 3. Viewport, Navigation & Styling Parity

| Feature ID | Specific Behavior | Reference File | SocratiQ Module | Parity Status | Test Suite & Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **NAV-01** | Pan tool pointer dragging | `App.tsx:1000` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **NAV-02** | Ctrl + Mouse wheel zoom (0.1x to 5.0x) | `App.tsx:1131` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **NAV-03** | Standard mouse wheel canvas panning | `App.tsx:1135` | `SmartBoard.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **NAV-04** | Toolbar Zoom In / Zoom Out buttons | `Toolbar.tsx:250`| `SmartBoardToolbar.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **NAV-05** | Fit-to-screen bounds calculation | `App.tsx:273` | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **NAV-06** | 9-color palette selection | `constants.ts` | `SmartBoardToolbar.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **NAV-07** | Solid fill vs outline toggle | `Toolbar.tsx:230`| `SmartBoardToolbar.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **NAV-08** | Text font size slider (12px to 128px) | `Toolbar.tsx:198`| `SmartBoardToolbar.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |
| **NAV-09** | Dark / Light theme canvas toggle | `Toolbar.tsx:159`| `SmartBoardToolbar.tsx` | `TESTED` | Vitest: `SmartBoard.test.tsx` |
| **NAV-10** | Linear Undo / Redo history stack | `App.tsx:214` | `lib/whiteboard.ts` | `TESTED` | Pytest & Vitest |
| **NAV-11** | Keyboard shortcuts: V, H, P, T, E, Ctrl+Z, Ctrl+Y | `Toolbar.tsx` | `BoardWorkspace.tsx` | `TESTED` | Vitest: `BoardWorkspace.test.tsx` |

---

## 4. AI & Realtime Parity

| Feature ID | Specific Behavior | Reference File | SocratiQ Module | Parity Status | Test Suite & Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AI-01** | AI Image generation (`generate_image`) | `server/index.js`| `smartboard.py` | `TESTED` | Live API 200 + Vitest placeholder |
| **AI-02** | AI Simulation generation (`generate_simulation`) | `server/index.js`| `smartboard.py` | `TESTED` | Live API 200 (5,087 bytes HTML) |
| **AI-03** | AI Vector Drawing (`generate_vector_drawing`) | `server/index.js`| `smartboard.py` | `TESTED` | Live API 200 (7 SVG elements) |
| **AI-04** | Tool execution: `pan_view`, `move_element_at`, etc. | `App.tsx:398` | `BoardWorkspace.tsx` | `TESTED` | Pytest: `test_smartboard_api.py` |
| **AI-05** | Multimodal Live WebSocket relay | `server/index.js`| `smartboard.py` | `TESTED` | Live Gemini WebSocket 101 switch |
| **AI-06** | Microphone audio capture (16kHz PCM) | `App.tsx:784` | `BoardWorkspace.tsx` | `IMPLEMENTED` | Mocked audio context in Vitest |
| **AI-07** | Speaker audio playback (24kHz PCM) | `App.tsx:54` | `BoardWorkspace.tsx` | `IMPLEMENTED` | Mocked audio context in Vitest |
| **AI-08** | Audio visualizer reactive bars | `Toolbar.tsx:57` | `SmartBoardToolbar.tsx` | `TESTED` | Vitest DOM test |
| **AI-09** | Canvas capture & vision streaming (2s interval) | `App.tsx:804` | `BoardWorkspace.tsx` | `IN PROGRESS` | Wiring into `BoardWorkspace.tsx` |
| **AI-10** | Floating SmartBoard Chat Bar & tool calling | `App.tsx:1170` | `BoardWorkspace.tsx` | `IN PROGRESS` | Wiring into `BoardWorkspace.tsx` |
