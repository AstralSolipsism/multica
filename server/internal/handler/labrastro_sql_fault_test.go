package handler

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// These faults surround real SQL and COMMIT, rather than replacing a service
// with a stub that merely reports that an enqueue was called.
type sqlFaultStarter struct {
	txStarter
	query   string
	commit  bool
	once    atomic.Bool
	observe func(pgx.Tx)
}

func (f *sqlFaultStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := f.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &sqlFaultTx{Tx: tx, fault: f}, nil
}

type sqlFaultTx struct {
	pgx.Tx
	fault  *sqlFaultStarter
	nested bool
}

func (t *sqlFaultTx) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := t.Tx.Begin(ctx)
	if err != nil {
		return nil, err
	}
	// Admission uses savepoints; keep SQL faults active inside them, while a
	// missing commit acknowledgement still refers to the outer durable commit.
	return &sqlFaultTx{Tx: tx, fault: t.fault, nested: true}, nil
}

func (t *sqlFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	r := t.Tx.QueryRow(ctx, sql, args...)
	if t.fault.query != "" && strings.Contains(sql, "-- name: "+t.fault.query+" ") && t.fault.once.CompareAndSwap(false, true) {
		return sqlFaultRow{Row: r, after: func() {
			if t.fault.observe != nil {
				t.fault.observe(t.Tx)
			}
		}}
	}
	return r
}

func (t *sqlFaultTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tag, err := t.Tx.Exec(ctx, sql, args...)
	if err == nil && t.fault.query != "" && strings.Contains(sql, "-- name: "+t.fault.query+" ") && t.fault.once.CompareAndSwap(false, true) {
		if t.fault.observe != nil {
			t.fault.observe(t.Tx)
		}
		return tag, errors.New("injected failure after SQL landed")
	}
	return tag, err
}
func (t *sqlFaultTx) Commit(ctx context.Context) error {
	err := t.Tx.Commit(ctx)
	if err == nil && !t.nested && t.fault.commit && t.fault.once.CompareAndSwap(false, true) {
		if t.fault.observe != nil {
			t.fault.observe(nil)
		}
		return errors.New("injected missing commit acknowledgement")
	}
	return err
}

type sqlFaultRow struct {
	pgx.Row
	after func()
}

func (r sqlFaultRow) Scan(dest ...any) error {
	if err := r.Row.Scan(dest...); err != nil {
		return err
	}
	r.after()
	return errors.New("injected failure after SQL landed")
}
