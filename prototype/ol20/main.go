// CLI surface for the Phase-0 cross-container exercise (item 4): the same
// store, driven from two different agent containers over the network.
//
// Content is only produced by explicit `read`/`candidates` — `list` returns
// paths and revisions only, which is the structural argument that this design
// never amounts to full prompt injection.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"
)

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
		fmt.Println("usage: ol20 <init|grant|list|read|save|candidates|orphans> ...")
		os.Exit(2)
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
		// grant <token> <project> <user|run> [ttlSeconds]
		must(len(args) >= 4, "grant token project kind [ttl]")
		var exp *time.Time
		if len(args) >= 5 {
			t := time.Now().Add(time.Duration(atoi(args[4])) * time.Second)
			exp = &t
		}
		must(st.Grant(ctx, args[1], args[2], args[3], exp))
		fmt.Println("granted")

	case "save":
		// save <token> <project> <path> <baseRev> <opID> <authorID> <content>
		must(len(args) >= 7, "save token project path base op author content")
		res, err := st.Save(ctx, SaveRequest{
			Token: args[1], ProjectID: args[2], Path: args[3],
			BaseRevision: int64(atoi(args[4])), OpID: args[5],
			AuthorKind: "run", AuthorID: args[6], Content: []byte(args[7]),
		})
		must(err)
		fmt.Printf("status=%s revision=%d replayed=%v\n", res.Status, res.Revision, res.Replayed)

	case "read":
		// read <token> <project> <path>
		must(len(args) >= 4, "read token project path")
		res, err := st.Read(ctx, args[1], args[2], args[3])
		must(err)
		fmt.Printf("revision=%d sha256=%s\ncontent=%s\n", res.Revision, res.SHA256[:12], res.Content)

	case "list":
		must(len(args) >= 4, "list token project prefix")
		paths, err := st.List(ctx, args[1], args[2], args[3])
		must(err)
		for _, p := range paths {
			fmt.Println(p)
		}

	case "candidates":
		must(len(args) >= 4, "candidates token project path")
		cs, err := st.Candidates(ctx, args[1], args[2], args[3])
		must(err)
		for _, c := range cs {
			fmt.Printf("candidate=%s base=%d author=%s sha=%s content=%s\n",
				c.ID[:8], c.BaseRevision, c.AuthorID, c.SHA256[:12], c.Content)
		}

	case "orphans":
		ks, err := st.Orphans(ctx)
		must(err)
		for _, k := range ks {
			fmt.Println("orphan:", k)
		}
		fmt.Printf("total=%d\n", len(ks))

	default:
		fmt.Println("unknown command", args[0])
		os.Exit(2)
	}
}

func must(err error, msgs ...string) {
	if err != nil {
		if len(msgs) > 0 {
			fmt.Fprintln(os.Stderr, msgs[0])
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func atoi(s string) int {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}
