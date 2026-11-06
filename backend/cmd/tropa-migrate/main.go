package main

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"os"
	"time"
	"tropa/backend/migrations"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	pool, e := pgxpool.New(ctx, dsn)
	if e != nil {
		log.Fatal("invalid database configuration")
	}
	defer pool.Close()
	if e = migrations.Apply(ctx, pool); e != nil {
		log.Fatal("migration failed: ", e)
	}
	if role := os.Getenv("RUNTIME_DB_ROLE"); role != "" {
		if e = migrations.GrantRuntime(ctx, pool, role); e != nil {
			log.Fatal("runtime grants failed: ", e)
		}
	}
	log.Print("migrations applied")
}
