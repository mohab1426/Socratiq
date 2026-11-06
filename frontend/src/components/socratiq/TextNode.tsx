import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';

interface TextNodeProps {
  text: string;
  color: string;
  fontSize: number;
}

export const TextNode: React.FC<TextNodeProps> = ({ text, color, fontSize }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Typeset MathJax whenever text changes, but wait for React to render the Markdown first
    if (containerRef.current && (window as any).MathJax) {
      setTimeout(() => {
          (window as any).MathJax.typesetPromise([containerRef.current]).catch((err: any) => console.log(err));
      }, 0);
    }
  }, [text]);

  return (
    <div 
      ref={containerRef}
      dir="auto"
      className="inline-block whitespace-pre-wrap font-sans markdown-content text-start"
      style={{ 
        color, 
        fontSize: `${fontSize}px`, 
        lineHeight: 1.5,
        minWidth: '20px',
        minHeight: '20px',
        maxWidth: '600px', // Prevent super wide text
        unicodeBidi: 'plaintext',
      }}
    >
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
};