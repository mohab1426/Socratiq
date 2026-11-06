export const MODEL_NAMES = {
  LIVE: 'gemini-3.8-live',
  IMAGE_GEN: 'gemini-3-pro-image-preview',
  THINKING: 'gemini-flash-latest',
};

export const whiteboardTools = [
  {
    name: 'pan_view',
    description: 'Moves the view (camera) to a specific location on the board. Use this when you add new elements to ensure the user sees them.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'Target Center X' },
        y: { type: 'NUMBER', description: 'Target Center Y' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'move_element_at',
    description: 'Moves an element found at a specific location to a new location. Use this when asked to move something the user is pointing at or describing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'Current X location of the element' },
        y: { type: 'NUMBER', description: 'Current Y location of the element' },
        new_x: { type: 'NUMBER', description: 'New X location' },
        new_y: { type: 'NUMBER', description: 'New Y location' },
      },
      required: ['x', 'y', 'new_x', 'new_y'],
    },
  },
  {
    name: 'delete_element_at',
    description: 'Deletes an element found at a specific location.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'X location of the element to delete' },
        y: { type: 'NUMBER', description: 'Y location of the element to delete' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'draw_rectangle',
    description: 'Draws a rectangle.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'X coordinate' },
        y: { type: 'NUMBER', description: 'Y coordinate' },
        width: { type: 'NUMBER', description: 'Width' },
        height: { type: 'NUMBER', description: 'Height' },
        color: { type: 'STRING', description: 'Hex color' },
        filled: { type: 'BOOLEAN', description: 'True for solid fill, False for transparent (outline only)' }
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_triangle',
    description: 'Draws a triangle.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'Bounding box X' },
        y: { type: 'NUMBER', description: 'Bounding box Y' },
        width: { type: 'NUMBER', description: 'Width' },
        height: { type: 'NUMBER', description: 'Height' },
        color: { type: 'STRING', description: 'Hex color' },
        filled: { type: 'BOOLEAN', description: 'True for solid fill' }
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_circle',
    description: 'Draws a circle.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'Center X' },
        y: { type: 'NUMBER', description: 'Center Y' },
        radius: { type: 'NUMBER', description: 'Radius' },
        color: { type: 'STRING', description: 'Hex color' },
        filled: { type: 'BOOLEAN', description: 'True for solid fill' }
      },
      required: ['x', 'y', 'radius', 'color'],
    },
  },
  {
    name: 'draw_line',
    description: 'Draws a straight line.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x1: { type: 'NUMBER', description: 'Start X' },
        y1: { type: 'NUMBER', description: 'Start Y' },
        x2: { type: 'NUMBER', description: 'End X' },
        y2: { type: 'NUMBER', description: 'End Y' },
        color: { type: 'STRING', description: 'Hex color' },
        strokeWidth: { type: 'NUMBER', description: 'Thickness' }
      },
      required: ['x1', 'y1', 'x2', 'y2', 'color'],
    },
  },
  {
    name: 'draw_path',
    description: 'Draws a freehand line/path using SVG d string. Use for sketches, curves, or annotations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pathData: { type: 'STRING', description: 'SVG d attribute' },
        color: { type: 'STRING', description: 'Hex color' },
        strokeWidth: { type: 'NUMBER', description: 'Thickness' },
      },
      required: ['pathData', 'color'],
    },
  },
  {
    name: 'draw_arrow',
    description: 'Draws a directional arrow from (x1, y1) to (x2, y2).',
    parameters: {
      type: 'OBJECT',
      properties: {
        x1: { type: 'NUMBER', description: 'Start X' },
        y1: { type: 'NUMBER', description: 'Start Y' },
        x2: { type: 'NUMBER', description: 'End X' },
        y2: { type: 'NUMBER', description: 'End Y' },
        color: { type: 'STRING', description: 'Hex color' },
      },
      required: ['x1', 'y1', 'x2', 'y2', 'color'],
    },
  },
  {
    name: 'write_text',
    description: 'Writes plain text notes or steps.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: 'Text content' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
        color: { type: 'STRING', description: 'Hex color' },
      },
      required: ['text', 'x', 'y'],
    },
  },
  {
    name: 'add_equation',
    description: 'Adds a rendered math equation using LaTeX syntax.',
    parameters: {
      type: 'OBJECT',
      properties: {
        latex: { type: 'STRING', description: 'LaTeX string (e.g. \\frac{a}{b} = c)' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
        color: { type: 'STRING', description: 'Hex color' },
      },
      required: ['latex', 'x', 'y'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generates a high-quality raster image. Use this for complex scenes, artistic requests, or photorealistic images.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Image description' },
        size: { type: 'STRING', description: '1K, 2K, or 4K' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
      },
      required: ['prompt', 'x', 'y'],
    },
  },
  {
    name: 'generate_simulation',
    description: 'Generates an interactive HTML/JS simulation. Use this for physics demos, math visualizations, or coding tasks.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Title' },
        prompt: { type: 'STRING', description: 'Description of the simulation behavior' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
      },
      required: ['title', 'prompt', 'x', 'y'],
    },
  },
  {
    name: 'generate_vector_drawing',
    description: 'Generates a complex vector drawing (flowcharts, diagrams, house plans). Use this when you need structured shapes that should remain editable.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Description of what to draw' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
      },
      required: ['prompt', 'x', 'y'],
    },
  },
  {
    name: 'add_plot',
    description: 'Generates an interactive mathematical plot or chart (e.g. y = sin(x), quadratic curves, physics graphs).',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Plot or function title' },
        expression: { type: 'STRING', description: 'Mathematical expression or description of the graph (e.g. "y = x^2 - 4x + 4")' },
        x: { type: 'NUMBER', description: 'X position' },
        y: { type: 'NUMBER', description: 'Y position' },
      },
      required: ['title', 'expression'],
    },
  },
  {
    name: 'clear_board',
    description: 'Clears all elements.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'search_course_materials',
    description: 'Searches uploaded course materials and textbook resources for relevant concepts, definitions, and formulas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search keywords or question about course concepts' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_board_context',
    description: 'Inspects structured elements currently on the board, including equations, student notes, and selected elements.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];

export const SMARTBOARD_COLORS = [
  '#000000', // Black
  '#ef4444', // Red
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#eab308', // Yellow
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#64748b', // Slate
  '#ffffff', // White
];

export const SMARTBOARD_SYSTEM_INSTRUCTION = `You are a smart, collaborative whiteboard and educational agent in SocratiQ.

[LANGUAGE POLICY]:
- Default Language: You MUST speak and respond in ENGLISH by default.
- All spoken voice responses, chat messages, and board annotations must default to English.
- If the student explicitly speaks to you in Arabic or asks questions in Arabic, respond fluently in Arabic.
- Do NOT speak or respond in Spanish under any circumstances unless explicitly requested by the student.

[PEDAGOGICAL & LEARNING POLICY]:
- Socratic Scaffolding: Act as an encouraging tutor. Ask guiding questions, offer progressive hints, and break complex topics into manageable steps.
- Academic Integrity: Never write the final direct solution or complete code to an assignment question when the student is asking for answers. Help them think through the intermediate steps.
- Material Grounding: Base your explanations on authorized course materials and assignment requirements. Clearly distinguish between course facts, assignment requirements, and your own explanations.
- If course material or assignment context does not mention a concept, acknowledge this limitation honestly; do not hallucinate citations.

[REAL-TIME BOARD AWARENESS & STUDENT INTERACTION]:
- Real-Time Freehand Tracking: The student interacts with the board by drawing, circling, underlining, crossing out, or selecting options.
- Freehand Selection Recognition: When the student circles or underlines an MCQ option (e.g. Option B), an equation, or a phrase, recognize their selection immediately. If their circle is ambiguous between two options, ask a gentle clarification question.
- Active Tutoring on Selection: When the student selects an option or term, respond to their choice Socratically: ask why they chose it, examine edge cases, or guide them to verify their hypothesis without immediately confirming or giving away the answer.

[READ-BEFORE-WRITE & WORK PROTECTION]:
- Strict Student Work Protection: NEVER delete, move, overwrite, or cover content authored by the student (author="student"). Student reasoning, notes, formulas, and freehand marks are sacred educational artifacts.
- Read Before Write: Before placing any new text, equation, shape, or diagram, always account for where student work and existing elements are located.
- Clean Collision-Free Placement: Place new content in open canvas space or neatly adjacent to relevant elements with clear spacing (minimum 24px gap). Never stack new boxes directly on top of existing elements.
- Connector Arrows: When connecting elements, route arrows cleanly between element borders rather than through the centers of text or shapes.

[VISUAL & BOARD DESIGN]:
- View Control: If you create content outside the current view, use 'pan_view' to move the camera to it.
- Manipulation: Use 'move_element_at' and 'delete_element_at' to modify coach-authored items. Never delete student items.
- Structure & Hierarchy: Maintain clean layout order: Title/Heading -> Diagrams/Shapes -> Equations -> Annotations -> Directional Arrows.
- Multi-Element Drawings: Arrange multi-step explanations cleanly in reading order without overlapping shapes or covering text.
- Simple Actions: For simple shapes, text, or equations, perform them directly.
- Complex Vectors: For structured diagrams (flowcharts, architecture, complex shapes), use 'generate_vector_drawing'.
- Raster Images: For artistic, photorealistic, or very complex scenes, use 'generate_image'.
- Simulations: For interactive code, physics, or math demos, use 'generate_simulation'.
- Search Materials: Use 'search_course_materials' to look up concepts in the student's authorized course resources.
- Board Inspection: Use 'get_board_context' to inspect what the student has written or drawn.`;

