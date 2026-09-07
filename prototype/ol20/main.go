// CLI surface, v2 (post-review): authors never come from the command line
// (the grant defines the actor), CONFLICT exits non-zero with a structured
// result line, argument boundaries are exact. Commands beyond v1: adopt,
// grant (test-only), expire (test-only).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"
)

// Exit codes: 0 success (incl. replay), 1 error, 3 conflict preserved.
const exitConflict = 3

func main() {
	pg := flag.String("pg", os.Getenv("OL20_PG"), "postgres URL")
	ep := flag.String("s3-endpoint", os.Getenv("OL20_S3_ENDPOINT"), "S3 endpoint")
	ak := flag.String("s3-key", os.Getenv("OL20_S3_KEY"), "S3 access key")
	sk := flag.String("s3-secret", os.Getenv("OL20_S3_SECRET"), "S3 secret")
	bucket := flag.String("bucket", "ol20-filetest", "bucket")
	region := flag.String("region", "us-east-1", "region")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		usage()
	}

	ctx := context.Background()
	st, err := OpenStore(ctx, *pg, *ep, *ak, *sk, *bucket, *region)
	must(err)
	defer st.Close()

	switch args[0] {
	case "init":
		ddl, err := os.ReadFile("schema.sql")
		must(err)
		must(st.InitSchema(ctx, string(ddl)))
		fmt.Println("schema ready")

	case "grant":
		// grant <token> <project> <user|run> <actorID> [ttlSeconds]  (test-only)
		needArgs(len(args) >= 5, "grant token project kind actorID [ttl]")
		var exp *time.Time
		if len(args) >= 6 {
			t := time.Now().Add(time.Duration(atoi(args[5])) * time.Second)
			exp = &t
		}
		must(st.Grant(ctx, args[1], args[2], args[3], args[4], exp))
		fmt.Println("granted")

	case "save":
		// save <token> <project> <path> <baseRev> <opID> <content>
		needArgs(len(args) >= 7, "save token project path base op content")
		res, err := st.Save(ctx, SaveRequest{
			Token: args[1], ProjectID: args[2], Path: args[3],
			BaseRevision: int64(atoi(args[4])), OpID: args[5], Content: []byte(args[6]),
		})
		must(err)
		fmt.Println(res.String())
		if res.Status == StatusConflict {
			os.Exit(exitConflict)
		}

	case "read":
		needArgs(len(args) >= 4, "read token project path")
		res, err := st.Read(ctx, args[1], args[2], args[3])
		must(err)
		fmt.Printf("revision=%d sha256=%s\ncontent=%s\n", res.Revision, res.SHA256[:12], res.Content)

	case "list":
		needArgs(len(args) >= 4, "list token project prefix")
		paths, err := st.List(ctx, args[1], args[2], args[3])
		must(err)
		for _, p := range paths {
			fmt.Println(p)
		}

	case "candidates":
		needArgs(len(args) >= 4, "candidates token project path")
		cs, err := st.Candidates(ctx, args[1], args[2], args[3])
		must(err)
		for _, c := range cs {
			fmt.Printf("candidate=%s base=%d author=%s sha=%s content=%s\n",
				c.ID[:8], c.BaseRevision, c.AuthorID, c.SHA256[:12], c.Content)
		}

	case "adopt":
		// adopt <token> <project> <path> <candidateID> <opID> <expectedRevision>
		needArgs(len(args) >= 7, "adopt token project path candidateID opID expectedRevision")
		res, err := st.AdoptCandidate(ctx, args[1], args[2], args[3], args[4], args[5], int64(atoi(args[6])))
		must(err)
		fmt.Println(res.String())
		if res.Status == StatusConflict {
			os.Exit(exitConflict)
		}

	case "orphans":
		ks, err := st.Orphans(ctx)
		must(err)
		for _, k := range ks {
			fmt.Println("orphan:", k)
		}
		fmt.Printf("total=%d\n", len(ks))

	default:
		usage()
	}
}

func usage() {
	fmt.Println("usage: ol20 <init|grant|list|read|save|candidates|adopt|orphans> ...")
	os.Exit(2)
}

func needArgs(cond bool, usageLine string) {
	if !cond {
		fmt.Fprintln(os.Stderr, "usage:", usageLine)
		os.Exit(2)
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func atoi(s string) int {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}
