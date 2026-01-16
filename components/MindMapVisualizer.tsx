
import React, { useState } from 'react';
import { MindMapNode } from '../types.ts';
import { Info, X } from 'lucide-react';

interface MindMapVisualizerProps {
  data: MindMapNode;
}

const MindMapVisualizer: React.FC<MindMapVisualizerProps> = ({ data }) => {
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);

  const renderNode = (node: MindMapNode, x: number, y: number, level: number, index: number, total: number) => {
    const isRoot = level === 0;
    const spacingX = isRoot ? 250 : 200;
    const spacingY = isRoot ? 120 : 100;
    
    // Simple vertical distribution for children
    const startY = y - ((total - 1) * spacingY) / 2;
    const currentY = startY + index * spacingY;
    const currentX = x + (level > 0 ? spacingX : 0);

    return (
      <g key={node.id} className="animate-in fade-in zoom-in duration-500">
        {/* Draw lines to children */}
        {node.children?.map((child, idx) => {
          const childTotal = node.children?.length || 0;
          const childSpacingY = level === 0 ? 120 : 100;
          const childStartY = currentY - ((childTotal - 1) * childSpacingY) / 2;
          const childY = childStartY + idx * childSpacingY;
          const childX = currentX + spacingX;
          
          return (
            <path
              key={`${node.id}-${child.id}`}
              d={`M ${currentX + 80} ${currentY} C ${currentX + 150} ${currentY}, ${currentX + 150} ${childY}, ${childX - 80} ${childY}`}
              fill="none"
              stroke="#cbd5e1"
              strokeWidth="2"
              className="transition-all"
            />
          );
        })}

        {/* Node box */}
        <foreignObject x={currentX - 80} y={currentY - 40} width="160" height="80">
          <div 
            onClick={() => setSelectedNode(node)}
            className={`w-full h-full p-3 rounded-2xl border-2 cursor-pointer transition-all flex flex-col items-center justify-center text-center shadow-sm hover:shadow-md hover:scale-105 ${
              level === 0 ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100' :
              level === 1 ? 'bg-white border-blue-200 text-gray-800' :
              'bg-gray-50 border-gray-100 text-gray-600'
            }`}
          >
            <span className={`font-black tracking-tight leading-tight line-clamp-2 ${level === 0 ? 'text-sm' : 'text-[11px]'}`}>
              {node.label}
            </span>
            {level === 0 && <span className="text-[8px] font-bold uppercase tracking-widest mt-1 opacity-70">Core Concept</span>}
          </div>
        </foreignObject>

        {/* Recurse children */}
        {node.children?.map((child, idx) => 
          renderNode(child, currentX, currentY, level + 1, idx, node.children?.length || 0)
        )}
      </g>
    );
  };

  return (
    <div className="relative w-full h-[600px] bg-white border border-gray-100 rounded-[48px] overflow-hidden shadow-inner">
      <div className="absolute top-8 left-8 z-10">
        <h3 className="text-[12px] font-black text-blue-600 uppercase tracking-[0.3em] flex items-center gap-2">
          <Info size={14} /> Interactive Mind Map
        </h3>
        <p className="text-gray-400 text-[10px] font-bold mt-1">Click a node to explore details</p>
      </div>

      <svg width="100%" height="100%" viewBox="0 0 1000 600" className="cursor-grab active:cursor-grabbing">
        <g transform="translate(150, 300)">
          {renderNode(data, 0, 0, 0, 0, 1)}
        </g>
      </svg>

      {/* Info Modal Overlay */}
      {selectedNode && (
        <div className="absolute inset-0 z-50 bg-indigo-900/10 backdrop-blur-sm flex items-center justify-center p-8 animate-in fade-in duration-300">
          <div className="bg-white w-full max-w-md p-10 rounded-[40px] shadow-2xl relative animate-in zoom-in-95 duration-300 border border-indigo-50">
            <button 
              onClick={() => setSelectedNode(null)}
              className="absolute top-6 right-6 p-2 bg-gray-50 rounded-full text-gray-400 hover:text-red-500 transition-colors"
            >
              <X size={20} />
            </button>
            <div className="space-y-4">
              <span className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">Concept Detail</span>
              <h4 className="text-3xl font-black text-gray-900 leading-tight">{selectedNode.label}</h4>
              <p className="text-lg text-gray-600 leading-relaxed font-medium italic">
                "{selectedNode.description}"
              </p>
              <div className="pt-6">
                <button 
                  onClick={() => setSelectedNode(null)}
                  className="w-full py-4 rounded-2xl bg-indigo-600 text-white font-black hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                >
                  GOT IT
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MindMapVisualizer;
