export const SELECT_EXISTING_CLASSIFY_JOBS = `
  SELECT osm_id, status, data, id
  FROM jobs
  WHERE job_type = 'classify'
    AND place_type = ?
`;

export const BOOST_PENDING_CLASSIFY_JOB = `
  UPDATE jobs
  SET priority = ?
  WHERE job_type = 'classify'
    AND place_type = ?
    AND osm_id = ?
    AND status = 'pending'
    AND priority < ?
`;
