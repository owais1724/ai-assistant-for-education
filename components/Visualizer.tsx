
import React, { useEffect, useState } from 'react';
import { AppState } from '../types.ts';

interface VisualizerProps {
  state: AppState;
}

const Visualizer: React.FC<VisualizerProps> = ({ state }) => {
  const [heights, setHeights] = useState([10, 10, 10, 10, 10, 10, 10]);

  useEffect(() => {
    let interval: number;
    if (state === AppState.LISTENING || state === AppState.SPEAKING) {
      interval = window.setInterval(() => {
        setHeights(heights.map(() => Math.random() * (state === AppState.SPEAKING ? 40 : 25) + 5));
      }, 100);
    } else {
      setHeights(new Array(7).fill(5));
    }
    return () => clearInterval(interval);
  }, [state]);

  return (
    <div className="flex items-end justify-center space-x-1.5 h-12 w-full">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-1.5 rounded-full transition-all duration-150 ${
            state === AppState.SPEAKING ? 'bg-indigo-500' : 
            state === AppState.LISTENING ? 'bg-blue-500' : 'bg-gray-200'
          }`}
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
};

export default Visualizer;
