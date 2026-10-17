import { Link } from "react-router";
import type { JobAssignments } from "../../api/candidates";
import type { CandidateJobAssignment } from "../../api/jobs";
import { canViewJobs, useAuth } from "../../auth/AuthProvider";
import { formatDate } from "../format";
import { Detail, JobStatusBadge } from "../job/JobParts";
import { Card } from "../States";

// The candidate's Job assignment, read from the Job relation (job_candidate):
// the PROCESSING job they are on now, and the completed / cancelled history.
// Never from the old free-text candidate_stages.job_id.

function JobLine({ job, historic = false }: { job: CandidateJobAssignment; historic?: boolean }) {
    const { user } = useAuth();
    const code = canViewJobs(user) ? <Link to={`/jobs/${job.jobId}`} className="font-medium text-primary hover:underline">{job.jobCode}</Link> : <span className="font-medium">{job.jobCode}</span>;
    return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Detail label="Internal job code">{code}</Detail>
            <Detail label="Company Job ID">{job.companyJobId ?? <span className="text-ink-muted">Not assigned</span>}</Detail>
            <Detail label="Job type">{job.jobType.name}</Detail>
            <Detail label="Company">{job.company.name}</Detail>
            <Detail label="Responsible agent">{job.responsibleAgent.name}</Detail>
            {historic && <Detail label="Status">{job.removed ? "Removed" : <JobStatusBadge status={job.status} />}</Detail>}
            {historic && <Detail label="Assigned">{formatDate(job.assignedAt)}</Detail>}
            {historic && job.status === "CANCELLED" && job.cancelReason && <Detail label="Cancel reason">{job.cancelReason}</Detail>}
        </dl>
    );
}

export function JobAssignmentPanel({ assignments }: { assignments: JobAssignments }) {
    return (
        <Card className="p-5">
            <section aria-label="Job assignment" className="space-y-4">
                <div>
                    <h2 className="text-headline-sm text-ink">Current processing job</h2>
                    <div className="mt-2">
                        {assignments.current ? <JobLine job={assignments.current} /> : <p className="text-body-sm text-ink-muted">Not assigned to a processing job.</p>}
                    </div>
                </div>
                {assignments.history.length > 0 && (
                    <div>
                        <h3 className="text-label-md text-ink">Job history</h3>
                        <ul className="mt-2 divide-y divide-border">
                            {assignments.history.map((job) => <li key={job.jobId} className="py-3 first:pt-0 last:pb-0"><JobLine job={job} historic /></li>)}
                        </ul>
                    </div>
                )}
            </section>
        </Card>
    );
}
