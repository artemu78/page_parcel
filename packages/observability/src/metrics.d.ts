export interface CounterMetric {
    inc(labels?: Record<string, string>, value?: number): void;
    get(labels?: Record<string, string>): number;
}
export interface HistogramMetric {
    observe(value: number, labels?: Record<string, string>): void;
    getValues(labels?: Record<string, string>): number[];
}
declare class InMemoryCounter implements CounterMetric {
    private values;
    private serializeLabels;
    inc(labels?: Record<string, string>, value?: number): void;
    get(labels?: Record<string, string>): number;
    export(name: string): string[];
}
declare class InMemoryHistogram implements HistogramMetric {
    private values;
    private serializeLabels;
    observe(value: number, labels?: Record<string, string>): void;
    getValues(labels?: Record<string, string>): number[];
    export(name: string): string[];
}
export declare class MetricsRegistry {
    acceptedJobsTotal: InMemoryCounter;
    completedJobsTotal: InMemoryCounter;
    failedJobsTotal: InMemoryCounter;
    blockedDestinationsTotal: InMemoryCounter;
    retryAttemptsTotal: InMemoryCounter;
    deadLetterJobsTotal: InMemoryCounter;
    renderDurationSeconds: InMemoryHistogram;
    pdfSizeBytes: InMemoryHistogram;
    queueLatencySeconds: InMemoryHistogram;
    toPrometheusText(): string;
}
export declare const metrics: MetricsRegistry;
export {};
//# sourceMappingURL=metrics.d.ts.map