import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, type IconComponent } from '@gitspace/ui';

export interface ModelOption {
  /** `provider/model`, or an extra row's own value (for example "" for Not set). */
  value: string;
  label: string;
  /** Provider shown beside the name; also matched by search. */
  provider?: string;
  /** Why no account can use the model now, and when one can again; shown greyed beside it. */
  unavailable?: string;
  /** Not choosable. */
  disabled?: boolean;
}

/** Every query word must match the model name, its id, or its provider, so "bedrock sonnet" narrows across both. */
export function matchesModelQuery(option: ModelOption, query: string): boolean {
  const haystack = `${option.label} ${option.value} ${option.provider ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/u).every((word) => haystack.includes(word));
}

/** `disableUnavailable`: a model no account can use now is shown but not choosable (a run picker); otherwise it stays
 * choosable (a role's model, which outlasts the limit). */
export function modelOptions(models: readonly { provider: string; id: string; name: string; unavailable?: { until: string; reason: string } | null }[], disableUnavailable = false): ModelOption[] {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`, label: model.name || model.id, provider: model.provider,
    ...(model.unavailable ? { unavailable: `${model.unavailable.reason} until ${new Date(model.unavailable.until).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, disabled: disableUnavailable } : {}),
  }));
}

export function ModelCombobox({ options, value, onValueChange, ariaLabel, placeholder = 'Search models…', disabled, clearable, size, variant, icon, side }: {
  options: readonly ModelOption[];
  value: string;
  onValueChange(value: string): void;
  ariaLabel: string;
  /** Shown while nothing is selected or typed. */
  placeholder?: string;
  disabled?: boolean;
  /** A ✕ that clears the selection to "". */
  clearable?: boolean;
  size?: 'default' | 'compact';
  variant?: 'bordered' | 'borderless';
  icon?: IconComponent;
  side?: 'top' | 'bottom';
}) {
  // The list hands rows back as the kit's base item type; the provider and availability live on our option.
  const byValue = new Map(options.map((option) => [option.value, option]));
  return <Combobox items={options} value={value} onValueChange={onValueChange} filter={matchesModelQuery} disabled={disabled} size={size}>
    {/* Selecting the shown model on focus or click (after Escape the field stays focused) makes typing start a fresh search instead of appending to its name. */}
    <ComboboxInput aria-label={ariaLabel} placeholder={placeholder} variant={variant} icon={icon} clearable={clearable}
      onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
    <ComboboxContent side={side}>
      <ComboboxEmpty>No matching models</ComboboxEmpty>
      <ComboboxList>{(item) => {
        const option = byValue.get(typeof item === 'string' ? item : item.value) ?? { value: typeof item === 'string' ? item : item.value, label: typeof item === 'string' ? item : item.label };
        return <ComboboxItem value={option.value} key={option.value} disabled={option.disabled}>
          <span className={`flex min-w-0 items-baseline gap-2${option.unavailable ? ' text-muted-foreground' : ''}`}>
            <span className="truncate">{option.label}</span>
            {option.provider ? <span className="shrink-0 text-caption text-muted-foreground">{option.provider}</span> : null}
            {option.unavailable ? <span className="shrink-0 text-caption text-muted-foreground">· {option.unavailable}</span> : null}
          </span>
        </ComboboxItem>;
      }}</ComboboxList>
    </ComboboxContent>
  </Combobox>;
}
