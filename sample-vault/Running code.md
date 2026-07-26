A block in a language Tulip can run gets a **Run** control in its header. The
output appears underneath and is never written into this file.

```js
console.log('hello from node')
console.error('this went to stderr')
```

```python
import sys
print("hello from python3")
print("and this to stderr", file=sys.stderr)
sys.exit(3)
```

```sh
echo "hello from sh"
pwd
```

A runaway block can be stopped with the same control.

```sh
echo "starting"
sleep 60
echo "never reached"
```

Rust is highlighted but not run, so this block keeps a plain header.

```rust
fn main() { println!("{}", 1 + 2); }
```
