import { cronJobs } from "convex/server";

// The validation bootstrap has no recurring jobs, even if an env var is changed.
export default cronJobs();
