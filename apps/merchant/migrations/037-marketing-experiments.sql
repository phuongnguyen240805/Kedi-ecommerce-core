
CREATE TABLE IF NOT EXISTS marketing_experiments(id TEXT PRIMARY KEY,kind TEXT NOT NULL,config TEXT NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_one_active_experiment ON marketing_experiments(kind) WHERE active=1;
CREATE TABLE IF NOT EXISTS marketing_assignments(experiment_id TEXT NOT NULL,email TEXT NOT NULL,variant TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(experiment_id,email));
