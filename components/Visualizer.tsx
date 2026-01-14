
import React from 'react';
import { AppState } from '../types.ts';

interface VisualizerProps {
  state: AppState;
}

const Visualizer: React.FC<VisualizerProps> = ({ state }) => {
  return (
    <div className="flex items-center justify-center space-x-2 h-16">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={`w-1 rounded-full bg-blue-500 transition-all duration-300 ${
            state === AppState.LISTENING || state === AppState.SPEAKING
              ? 'animate-bounce'
              : 'h-2 opacity-30'
          }`}
          style={{
            animationDelay: `${i * 0.1}s`,
            height: state === AppState.LISTENING || state === AppState.SPEAKING 
              ? `${Math.random() * 40 + 10}px` 
              : '8px'
          }}
        />
      ))}
    </div>
  );
};

export default Visualizer;
