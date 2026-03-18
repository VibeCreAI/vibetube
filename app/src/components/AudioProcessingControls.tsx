import { Checkbox } from '@/components/ui/checkbox';

export interface AudioProcessingControlState {
  autoGainControl: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
}

export function AudioProcessingControls({
  audioProcessing,
  onAudioProcessingChange,
  idPrefix = 'audio-processing',
}: {
  audioProcessing: AudioProcessingControlState;
  onAudioProcessingChange: (next: AudioProcessingControlState) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Microphone Processing</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <ToggleCard
          id={`${idPrefix}-auto-gain`}
          label="Auto Gain"
          checked={audioProcessing.autoGainControl}
          onCheckedChange={(checked) =>
            onAudioProcessingChange({
              ...audioProcessing,
              autoGainControl: checked,
            })
          }
        />
        <ToggleCard
          id={`${idPrefix}-noise-suppression`}
          label="Noise Suppression"
          checked={audioProcessing.noiseSuppression}
          onCheckedChange={(checked) =>
            onAudioProcessingChange({
              ...audioProcessing,
              noiseSuppression: checked,
            })
          }
        />
        <ToggleCard
          id={`${idPrefix}-echo-cancellation`}
          label="Echo Cancellation"
          checked={audioProcessing.echoCancellation}
          onCheckedChange={(checked) =>
            onAudioProcessingChange({
              ...audioProcessing,
              echoCancellation: checked,
            })
          }
        />
      </div>
    </div>
  );
}

function ToggleCard({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label htmlFor={id} className="cursor-pointer">
        {label}
      </label>
    </div>
  );
}
