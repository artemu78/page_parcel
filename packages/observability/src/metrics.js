"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metrics = exports.MetricsRegistry = void 0;
class InMemoryCounter {
    values = new Map();
    serializeLabels(labels) {
        if (!labels || Object.keys(labels).length === 0)
            return '';
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }
    inc(labels, value = 1) {
        const key = this.serializeLabels(labels);
        this.values.set(key, (this.values.get(key) || 0) + value);
    }
    get(labels) {
        const key = this.serializeLabels(labels);
        return this.values.get(key) || 0;
    }
    export(name) {
        const lines = [];
        for (const [key, val] of this.values.entries()) {
            if (key) {
                lines.push(`${name}{${key}} ${val}`);
            }
            else {
                lines.push(`${name} ${val}`);
            }
        }
        return lines;
    }
}
class InMemoryHistogram {
    values = new Map();
    serializeLabels(labels) {
        if (!labels || Object.keys(labels).length === 0)
            return '';
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }
    observe(value, labels) {
        const key = this.serializeLabels(labels);
        const arr = this.values.get(key) || [];
        arr.push(value);
        this.values.set(key, arr);
    }
    getValues(labels) {
        const key = this.serializeLabels(labels);
        return this.values.get(key) || [];
    }
    export(name) {
        const lines = [];
        for (const [key, samples] of this.values.entries()) {
            const count = samples.length;
            const sum = samples.reduce((acc, v) => acc + v, 0);
            const labelPrefix = key ? `{${key}}` : '';
            lines.push(`${name}_count${labelPrefix} ${count}`);
            lines.push(`${name}_sum${labelPrefix} ${sum}`);
        }
        return lines;
    }
}
class MetricsRegistry {
    acceptedJobsTotal = new InMemoryCounter();
    completedJobsTotal = new InMemoryCounter();
    failedJobsTotal = new InMemoryCounter(); // label: category
    blockedDestinationsTotal = new InMemoryCounter(); // label: reason
    retryAttemptsTotal = new InMemoryCounter();
    deadLetterJobsTotal = new InMemoryCounter();
    renderDurationSeconds = new InMemoryHistogram();
    pdfSizeBytes = new InMemoryHistogram();
    queueLatencySeconds = new InMemoryHistogram();
    toPrometheusText() {
        const lines = [
            '# TYPE readable_web_accepted_jobs_total counter',
            ...this.acceptedJobsTotal.export('readable_web_accepted_jobs_total'),
            '# TYPE readable_web_completed_jobs_total counter',
            ...this.completedJobsTotal.export('readable_web_completed_jobs_total'),
            '# TYPE readable_web_failed_jobs_total counter',
            ...this.failedJobsTotal.export('readable_web_failed_jobs_total'),
            '# TYPE readable_web_blocked_destinations_total counter',
            ...this.blockedDestinationsTotal.export('readable_web_blocked_destinations_total'),
            '# TYPE readable_web_retry_attempts_total counter',
            ...this.retryAttemptsTotal.export('readable_web_retry_attempts_total'),
            '# TYPE readable_web_dead_letter_jobs_total counter',
            ...this.deadLetterJobsTotal.export('readable_web_dead_letter_jobs_total'),
            '# TYPE readable_web_render_duration_seconds histogram',
            ...this.renderDurationSeconds.export('readable_web_render_duration_seconds'),
            '# TYPE readable_web_pdf_size_bytes histogram',
            ...this.pdfSizeBytes.export('readable_web_pdf_size_bytes'),
            '# TYPE readable_web_queue_latency_seconds histogram',
            ...this.queueLatencySeconds.export('readable_web_queue_latency_seconds')
        ];
        return lines.join('\n') + '\n';
    }
}
exports.MetricsRegistry = MetricsRegistry;
exports.metrics = new MetricsRegistry();
//# sourceMappingURL=metrics.js.map