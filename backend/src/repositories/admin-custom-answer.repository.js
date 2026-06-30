import { pool } from '../db/pool.js';

// Data access for admin-authored custom Q&A overrides. All SQL is parameterized.
// Matching/duplicate logic lives in the service + routes; this layer is queries.

// Audience set for matching a user audience against stored answers: the visitor's
// own audience plus 'all'. Specific audience is preferred over 'all' by ORDER BY.
function audienceSet(userAudience) {
  const a = ['vet', 'pet_parent', 'unknown'].includes(userAudience) ? userAudience : 'unknown';
  return ['all', a];
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    websiteId: Number(row.website_id),
    question: row.question,
    normalizedQuestion: row.normalized_question,
    answer: row.answer,
    audience: row.audience,
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Admin list with optional search/audience/status filters + pagination.
export async function listCustomAnswers({ websiteId, search, audience, status, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const clauses = ['website_id = $1'];
  const params = [websiteId];
  if (audience) { params.push(audience); clauses.push(`audience = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(question ILIKE $${params.length} OR answer ILIKE $${params.length})`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const countRes = await pool.query(`SELECT count(*)::int AS total FROM admin_custom_answers ${where}`, params);
  const total = countRes.rows[0]?.total ?? 0;

  const listParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `SELECT * FROM admin_custom_answers
     ${where}
     ORDER BY priority DESC, updated_at DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );
  return { items: rows.map(mapRow), total, limit: safeLimit, offset: safeOffset };
}

export async function getCustomAnswerById({ websiteId, id }) {
  const { rows } = await pool.query(
    'SELECT * FROM admin_custom_answers WHERE website_id = $1 AND id = $2',
    [websiteId, id],
  );
  return mapRow(rows[0]);
}

export async function createCustomAnswer({ websiteId, question, normalizedQuestion, answer, audience, status, priority, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO admin_custom_answers
       (website_id, question, normalized_question, answer, audience, status, priority, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [websiteId, question, normalizedQuestion, answer, audience, status, priority, createdBy ?? null],
  );
  return mapRow(rows[0]);
}

export async function updateCustomAnswer({ websiteId, id, question, normalizedQuestion, answer, audience, status, priority }) {
  const { rows } = await pool.query(
    `UPDATE admin_custom_answers
        SET question = $3,
            normalized_question = $4,
            answer = $5,
            audience = $6,
            status = $7,
            priority = $8,
            updated_at = now()
      WHERE website_id = $1 AND id = $2
      RETURNING *`,
    [websiteId, id, question, normalizedQuestion, answer, audience, status, priority],
  );
  return mapRow(rows[0]);
}

export async function deleteCustomAnswer({ websiteId, id }) {
  const { rowCount } = await pool.query(
    'DELETE FROM admin_custom_answers WHERE website_id = $1 AND id = $2',
    [websiteId, id],
  );
  return rowCount > 0;
}

// Exact active match for a user's normalized question, honoring audience scope.
// Specific audience beats 'all'; then higher priority; then most recently updated.
export async function findExactCustomAnswer({ websiteId, normalizedQuestion, audience }) {
  const { rows } = await pool.query(
    `SELECT * FROM admin_custom_answers
      WHERE website_id = $1
        AND status = 'active'
        AND normalized_question = $2
        AND audience = ANY($3)
      ORDER BY (audience <> 'all') DESC, priority DESC, updated_at DESC
      LIMIT 1`,
    [websiteId, normalizedQuestion, audienceSet(audience)],
  );
  return mapRow(rows[0]);
}

// Active answers in the user's audience scope, for in-JS fuzzy comparison.
export async function findCandidateCustomAnswers({ websiteId, audience, limit = 500 }) {
  const { rows } = await pool.query(
    `SELECT * FROM admin_custom_answers
      WHERE website_id = $1
        AND status = 'active'
        AND audience = ANY($2)
      ORDER BY (audience <> 'all') DESC, priority DESC, updated_at DESC
      LIMIT $3`,
    [websiteId, audienceSet(audience), Math.min(Math.max(Number(limit) || 500, 1), 2000)],
  );
  return rows.map(mapRow);
}

// Exact duplicate check on (website, normalized question, audience), optionally
// excluding a row (used when editing). Returns the existing row or null.
export async function checkDuplicateCustomAnswer({ websiteId, normalizedQuestion, audience, excludeId = null }) {
  const params = [websiteId, normalizedQuestion, audience];
  let sql = `SELECT * FROM admin_custom_answers
              WHERE website_id = $1 AND normalized_question = $2 AND audience = $3`;
  if (excludeId != null) { params.push(excludeId); sql += ` AND id <> $${params.length}`; }
  sql += ' LIMIT 1';
  const { rows } = await pool.query(sql, params);
  return mapRow(rows[0]);
}
