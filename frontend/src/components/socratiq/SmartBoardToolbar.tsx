import React, { useEffect, useState } from 'react';
import { SMARTBOARD_COLORS } from '@/lib/smartboardConstants';
import { 
  MousePointer2, 
  Hand,
  Pencil, 
  Highlighter,
  Eraser,
  Type,
  Sigma,
  MoveUpRight,
  Square, 
  Circle, 
  Triangle,
  Minus,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  Sun,
  Moon,
  Mic, 
  MicOff,
  ZoomIn,
  ZoomOut,
  Maximize,
  Maximize2,
  Minimize2,
  BoxSelect,
  Loader2,
} from 'lucide-react';
import type { Tool } from './SmartBoard';

export interface AIState {
  isConnected: boolean;
  isListening: boolean;
  modelState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting';
}

interface ToolbarProps {
  currentTool: Tool;
  setTool: (t: Tool) => void;
  currentColor: string;
  setColor: (c: string) => void;
  strokeWidth?: number;
  setStrokeWidth?: (w: number) => void;
  filled: boolean;
  setFilled: (f: boolean) => void;
  fontSize: number;
  setFontSize: (s: number) => void;
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
  aiState: AIState;
  isAIProcessing: boolean;
  onToggleMic: () => void;
  onUndo: () => void;
  onRedo: () => void;
  confirmClear?: boolean;
  onClearClick?: () => void;
  onClearConfirm?: () => void;
  onClearCancel?: () => void;
  canClear?: boolean;
  locked?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onImageUpload: () => void;
  onEquationClick?: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onReorder?: (direction: "front" | "back") => void;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoomScale?: number;
  onScaleSelected?: (factor: number) => void;
  onSetSizePreset?: (preset: "small" | "medium" | "large") => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

const AudioVisualizer: React.FC<{ isSpeaking: boolean, theme: 'light' | 'dark' }> = ({ isSpeaking, theme }) => {
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    const handleVolumeUpdate = (e: CustomEvent) => {
      setVolume(e.detail);
    };
    window.addEventListener('audio-volume-update', handleVolumeUpdate as EventListener);
    return () => window.removeEventListener('audio-volume-update', handleVolumeUpdate as EventListener);
  }, []);

  return (
    <div className="flex gap-0.5 h-4 items-end justify-center px-0.5">
      {[1, 2, 3].map((i) => {
        let heightPerc = 20;
        if (isSpeaking) {
          heightPerc = 40 + (volume * 100 * (i % 2 === 0 ? 1 : 0.5));
        } else {
          heightPerc = 20 + (volume * 400 * (1 - i * 0.1));
        }
        const height = `${Math.min(100, Math.max(20, heightPerc))}%`;
        return (
          <div
            key={i}
            className={`w-0.5 rounded-full transition-all duration-100 ease-out ${
              isSpeaking
                ? 'bg-indigo-400'
                : theme === 'dark'
                ? 'bg-emerald-400'
                : 'bg-emerald-500'
            }`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
};

export const SmartBoardToolbar: React.FC<ToolbarProps> = ({
  currentTool,
  setTool,
  currentColor,
  setColor,
  strokeWidth = 4,
  setStrokeWidth,
  filled,
  setFilled,
  fontSize,
  setFontSize,
  theme,
  setTheme,
  aiState,
  isAIProcessing,
  onToggleMic,
  onUndo,
  onRedo,
  confirmClear,
  onClearClick,
  onClearConfirm,
  onClearCancel,
  canClear = false,
  locked = false,
  onZoomIn,
  onZoomOut,
  onFitView,
  onImageUpload,
  onDelete,
  onDuplicate,
  onReorder,
  hasSelection,
  canUndo,
  canRedo,
  zoomScale = 0.4,
  onScaleSelected,
  onSetSizePreset,
  isFullscreen = false,
  onToggleFullscreen,
}) => {
  const isDark = theme === 'dark';
  const baseClasses = `backdrop-blur-md rounded-2xl shadow-xl border transition-colors duration-200 select-none ${
    isDark ? 'bg-zinc-900/95 border-zinc-700/80 text-zinc-100 shadow-black/40' : 'bg-white/95 border-gray-200/90 text-gray-800 shadow-slate-900/10'
  }`;
  const btnClasses = `min-w-[36px] min-h-[36px] sm:min-w-[32px] sm:min-h-[32px] w-9 h-9 sm:w-8 sm:h-8 rounded-xl transition-all flex items-center justify-center shrink-0 touch-manipulation ${
    isDark
      ? 'hover:bg-zinc-800 text-zinc-300 hover:text-white'
      : 'hover:bg-gray-100 text-gray-600 hover:text-gray-900'
  }`;
  const activeBtnClasses = `bg-teal-700 dark:bg-teal-600 text-white font-semibold shadow-sm hover:text-white hover:bg-teal-800 dark:hover:bg-teal-500`;

  const ToolButton = ({
    tool,
    icon: Icon,
    label,
    title,
    onClick,
    isActive,
  }: {
    tool?: Tool;
    icon: any;
    label: string;
    title?: string;
    onClick?: () => void;
    isActive?: boolean;
  }) => {
    const isPressed = isActive !== undefined ? isActive : (tool !== undefined && currentTool === tool);
    return (
      <button
        onClick={onClick || (() => tool && setTool(tool))}
        className={`group relative ${btnClasses} ${isPressed ? activeBtnClasses : ''} ${
          locked ? 'opacity-40 cursor-not-allowed' : ''
        }`}
        title={title || label}
        aria-label={label}
        aria-pressed={isPressed ? "true" : "false"}
        disabled={locked}
        type="button"
      >
        <Icon size={17} />
      </button>
    );
  };

  const showContextualBar =
    hasSelection ||
    ['pen', 'highlighter', 'text', 'rect', 'ellipse', 'triangle', 'line', 'arrow'].includes(currentTool);

  return (
    <>
      {/* 1. TOP PRIMARY DOCK: Core Creation, Selection & History */}
      <div
        role="toolbar"
        aria-label="Whiteboard tools"
        data-board-occluder="toolbar"
        className={`absolute top-2 left-2 right-[148px] sm:right-[156px] lg:right-auto lg:top-3 lg:left-1/2 lg:-translate-x-1/2 flex items-center gap-0.5 sm:gap-1 p-1 sm:p-1.5 z-30 lg:max-w-[calc(100vw-14rem)] overflow-x-auto thin-scroll ${baseClasses}`}
      >
        {/* Navigation & Selection Group */}
        <div className="flex items-center gap-0.5">
          <ToolButton tool="select" icon={MousePointer2} label="Select and move" title="Select and move (V)" />
          <ToolButton tool="pan" icon={Hand} label="Pan canvas" title="Pan canvas (H)" />
        </div>

        <div className={`h-5 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        {/* Inking Group */}
        <div className="flex items-center gap-0.5">
          <ToolButton tool="pen" icon={Pencil} label="Pen" title="Pen (P)" />
          <ToolButton tool="highlighter" icon={Highlighter} label="Highlighter" title="Highlighter" />
          <ToolButton tool="eraser" icon={Eraser} label="Eraser" title="Eraser (E)" />
        </div>

        <div className={`h-5 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        {/* Text & Equation Group */}
        <div className="flex items-center gap-0.5">
          <ToolButton tool="text" icon={Type} label="Text" title="Text (T)" />
          <ToolButton tool="equation" icon={Sigma} label="Equation" title="Equation (LaTeX)" onClick={() => setTool("equation")} />
        </div>

        <div className={`h-5 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        {/* Shapes Group */}
        <div className="flex items-center gap-0.5">
          <ToolButton tool="rect" icon={Square} label="Rectangle" title="Rectangle (R)" />
          <ToolButton tool="ellipse" icon={Circle} label="Ellipse" title="Ellipse (O)" />
          <ToolButton tool="triangle" icon={Triangle} label="Triangle" title="Triangle" />
          <ToolButton tool="line" icon={Minus} label="Line" title="Line (L)" />
          <ToolButton tool="arrow" icon={MoveUpRight} label="Arrow" title="Arrow (A)" />
        </div>

        <div className={`h-5 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        {/* Image Upload */}
        <div className="flex items-center gap-0.5">
          <ToolButton icon={ImageIcon} label="Upload Image" title="Upload Image" onClick={onImageUpload} isActive={false} />
        </div>

        <div className={`h-5 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        {/* Undo / Redo / Clear Group */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={onUndo}
            disabled={locked || !canUndo}
            className={`${btnClasses} ${(locked || !canUndo) ? 'opacity-30 cursor-not-allowed' : ''}`}
            title="Undo"
            aria-label="Undo"
            type="button"
          >
            <Undo2 size={17} />
          </button>
          <button
            onClick={onRedo}
            disabled={locked || !canRedo}
            className={`${btnClasses} ${(locked || !canRedo) ? 'opacity-30 cursor-not-allowed' : ''}`}
            title="Redo"
            aria-label="Redo"
            type="button"
          >
            <Redo2 size={17} />
          </button>
          {confirmClear ? (
            <div className="flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={onClearConfirm}
                className="text-xs px-2 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 whitespace-nowrap"
                aria-label="Clear everything?"
                title="Clear everything?"
              >
                Clear everything?
              </button>
              <button
                type="button"
                onClick={onClearCancel}
                className="text-xs px-2 py-1 rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-zinc-800 dark:text-zinc-200"
                aria-label="Keep"
                title="Keep"
              >
                Keep
              </button>
            </div>
          ) : (
            <button
              onClick={onClearClick}
              disabled={locked || !canClear}
              className={`${btnClasses} ${(locked || !canClear) ? 'opacity-30 cursor-not-allowed' : ''}`}
              title="Clear the board"
              aria-label="Clear the board"
              type="button"
            >
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </div>

      {/* 2. CONTEXTUAL PROPERTIES & SIZING BAR: Color, Fill, Font, Object Sizing */}
      {showContextualBar && (
        <div
          data-board-occluder="contextual"
          className={`absolute top-14 left-2 lg:top-16 lg:left-1/2 lg:-translate-x-1/2 flex items-center gap-1.5 sm:gap-2 p-1 sm:p-1.5 px-2 sm:px-3 z-30 max-w-[calc(100vw-1rem)] lg:max-w-[calc(100vw-6rem)] overflow-x-auto thin-scroll animate-in fade-in slide-in-from-top-1 ${baseClasses}`}
        >
          {/* Color Palette Swatches */}
          <div className="flex items-center gap-1.5 px-1">
            {SMARTBOARD_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-5 h-5 sm:w-4 sm:h-4 pointer-coarse:w-7! pointer-coarse:h-7! rounded-full border border-black/15 transition-all shrink-0 touch-manipulation ${
                  currentColor === c ? 'ring-2 ring-offset-1 ring-teal-600 scale-125' : 'hover:scale-110'
                }`}
                style={{ backgroundColor: c }}
                title={`Color: ${c}`}
              />
            ))}
          </div>

          <div className={`h-4 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

          {/* Stroke Width Selector (When Pen, Highlighter, or Line is active) */}
          {['pen', 'highlighter', 'line', 'arrow'].includes(currentTool) && setStrokeWidth && (
            <>
              <div className="flex items-center gap-1 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mr-0.5 hidden sm:inline">Width:</span>
                {[2, 4, 6, 8].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setStrokeWidth(w)}
                    className={`w-6 h-6 pointer-coarse:w-9! pointer-coarse:h-9! rounded-lg flex items-center justify-center transition-colors ${
                      strokeWidth === w
                        ? isDark
                          ? 'bg-zinc-700 text-white font-bold ring-1 ring-teal-500'
                          : 'bg-gray-200 text-gray-900 font-bold ring-1 ring-teal-600'
                        : isDark
                        ? 'hover:bg-zinc-800 text-zinc-400'
                        : 'hover:bg-gray-100 text-gray-600'
                    }`}
                    title={`Stroke width: ${w}px`}
                  >
                    <div
                      className="rounded-full bg-current"
                      style={{ width: `${w + 2}px`, height: `${w + 2}px` }}
                    />
                  </button>
                ))}
              </div>
              <div className={`h-4 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
            </>
          )}

          {/* Fill Mode Toggle */}
          <button
            type="button"
            onClick={() => setFilled(!filled)}
            className={`p-1.5 pointer-coarse:p-2.5 rounded-lg text-xs flex items-center gap-1 transition-colors ${
              filled
                ? isDark
                  ? 'bg-zinc-700 text-white font-medium'
                  : 'bg-gray-200 text-gray-900 font-medium'
                : isDark
                ? 'hover:bg-zinc-800 text-zinc-400'
                : 'hover:bg-gray-100 text-gray-600'
            }`}
            title={filled ? "Fill: Solid (Click for Outline)" : "Fill: Outline only (Click for Solid)"}
          >
            <BoxSelect size={15} fill={filled ? "currentColor" : "none"} />
            <span className="text-[11px] font-medium hidden sm:inline">{filled ? "Filled" : "Outline"}</span>
          </button>

          {/* Font Size Slider (When Text is selected or Text tool is active) */}
          {(currentTool === "text" || hasSelection) && (
            <>
              <div className={`h-4 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
              <div className="flex items-center gap-1.5 px-1">
                <Type size={14} className="text-gray-400" />
                <input
                  type="range"
                  min="14"
                  max="128"
                  step="4"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-16 sm:w-20 accent-teal-600 cursor-pointer"
                  title={`Font Size: ${fontSize}px`}
                />
                <span className="text-[11px] font-mono text-gray-500 w-5 text-center">{fontSize}</span>
              </div>
            </>
          )}

          {/* Content Sizing Controls (When Elements are Selected) */}
          {hasSelection && (
            <>
              <div className={`h-4 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mr-0.5 hidden sm:inline">Size:</span>
                {onSetSizePreset && (
                  <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 bg-gray-50 dark:bg-zinc-800/80">
                    <button
                      type="button"
                      onClick={() => onSetSizePreset('small')}
                      className="px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 text-[10px] font-semibold rounded hover:bg-white dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-200"
                      title="Set size: Small"
                      aria-label="Set size: Small"
                    >
                      S
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetSizePreset('medium')}
                      className="px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 text-[10px] font-semibold rounded hover:bg-white dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-200"
                      title="Set size: Medium"
                      aria-label="Set size: Medium"
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetSizePreset('large')}
                      className="px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 text-[10px] font-semibold rounded hover:bg-white dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-200"
                      title="Set size: Large"
                      aria-label="Set size: Large"
                    >
                      L
                    </button>
                  </div>
                )}
                {onScaleSelected && (
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onScaleSelected(0.85)}
                      className="px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 text-xs font-bold rounded-lg border border-[var(--color-border)] hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-200"
                      title="Scale down 15%"
                      aria-label="Scale down 15%"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => onScaleSelected(1.15)}
                      className="px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:min-w-9 text-xs font-bold rounded-lg border border-[var(--color-border)] hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-200"
                      title="Scale up 15%"
                      aria-label="Scale up 15%"
                    >
                      +
                    </button>
                  </div>
                )}
                {onDuplicate && (
                  <button
                    type="button"
                    onClick={onDuplicate}
                    className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-200 transition-colors ml-0.5"
                    title="Duplicate selected (Ctrl+D)"
                    aria-label="Duplicate selected"
                  >
                    <Copy size={15} />
                  </button>
                )}
                {onReorder && (
                  <div className="flex items-center gap-0.5 ml-0.5">
                    <button
                      type="button"
                      onClick={() => onReorder("front")}
                      className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-200 transition-colors"
                      title="Bring to front"
                      aria-label="Bring to front"
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onReorder("back")}
                      className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-200 transition-colors"
                      title="Send to back"
                      aria-label="Send to back"
                    >
                      <ArrowDown size={15} />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={onDelete}
                  className="p-1 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-900/60 transition-colors ml-1"
                  title="Delete selected (Del)"
                  aria-label="Delete selected"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 3. VIEWPORT & ZOOM DOCK: Bottom-Right Corner */}
      <div
        data-board-occluder="zoom"
        className={`absolute bottom-16 right-2 lg:bottom-4 lg:right-4 flex items-center gap-0.5 sm:gap-1 p-0.5 sm:p-1 px-1 sm:px-1.5 z-30 ${baseClasses}`}
      >
        <button
          type="button"
          onClick={onZoomOut}
          className={btnClasses}
          title="Zoom Out"
          aria-label="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          onClick={onFitView}
          className="px-1 sm:px-1.5 py-1 text-xs font-mono font-medium rounded hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-300"
          title="Zoom level (Click to fit content)"
          aria-label={`Zoom level ${Math.round((zoomScale || 0.4) * 100)}%. Click to fit content`}
        >
          {Math.round((zoomScale || 0.4) * 100)}%
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          className={btnClasses}
          title="Zoom In"
          aria-label="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          onClick={onFitView}
          className={btnClasses}
          title="Fit to Screen"
          aria-label="Fit to Screen"
        >
          <Maximize size={16} />
        </button>
      </div>

      {/* 4. LIVE & THEME PILL: Top-Right Corner */}
      <div
        data-board-occluder="utility"
        className={`absolute top-2 right-2 lg:top-3 lg:right-3 flex items-center gap-1 sm:gap-1.5 p-1 px-1.5 z-30 shrink-0 ${baseClasses}`}
      >
        <button
          onClick={onToggleMic}
          type="button"
          className={`
            w-9 h-9 sm:w-8 sm:h-8 rounded-full flex items-center justify-center transition-all shrink-0 touch-manipulation
            ${
              aiState.isConnected
                ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200 ring-2 ring-red-400'
                : aiState.modelState === 'connecting'
                ? 'bg-amber-500 hover:bg-amber-600 text-white animate-pulse'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200'
            }
          `}
          title={
            aiState.isConnected
              ? "Disconnect Gemini Live"
              : aiState.modelState === 'connecting'
              ? "Connecting..."
              : "Connect Gemini Live Voice"
          }
          aria-label={aiState.isConnected ? "Disconnect Gemini Live" : "Connect Gemini Live Voice"}
        >
          {aiState.modelState === 'connecting' ? (
            <Loader2 size={16} className="animate-spin" />
          ) : aiState.isConnected ? (
            <MicOff size={16} />
          ) : (
            <Mic size={16} />
          )}
        </button>

        {aiState.isConnected && (
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              {aiState.modelState === 'speaking' ? 'Speaking' : 'Listening'}
            </span>
            <AudioVisualizer isSpeaking={aiState.modelState === 'speaking'} theme={theme} />
          </div>
        )}

        {isAIProcessing && (
          <div className="animate-spin text-teal-600 px-0.5"><Loader2 size={15} /></div>
        )}

        <div className={`h-4 w-px mx-0.5 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`} />

        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className={btnClasses}
          title="Toggle Dark/Light Mode"
          aria-label="Toggle Dark/Light Mode"
          type="button"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className={btnClasses}
            title={isFullscreen ? "Exit Fullscreen (Esc)" : "Enter Fullscreen"}
            aria-label={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            aria-pressed={isFullscreen}
            type="button"
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
      </div>
    </>
  );
};
