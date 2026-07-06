import { Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { useSocketEvent } from '../../hooks/useSocketEvent.js';
import PulsingDot from '../ui/PulsingDot.jsx';

export default function EslStatusBanner({ initialConnected = false, host = '', port = 8021 }) {
  const [esl, setEsl] = useState({ connected: initialConnected, host, port });

  useSocketEvent('esl.status', (payload) => setEsl(payload));

  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded-lg text-xs font-medium
      ${esl.connected
        ? 'bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400'
        : 'bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400'}`}>
      <PulsingDot active={esl.connected} size="sm" />
      <span className="flex items-center gap-1.5">
        {esl.connected
          ? <><Wifi size={12} /> FreeSWITCH ESL connected — {esl.host}:{esl.port}</>
          : <><WifiOff size={12} /> FreeSWITCH ESL disconnected — retrying…</>}
      </span>
    </div>
  );
}
