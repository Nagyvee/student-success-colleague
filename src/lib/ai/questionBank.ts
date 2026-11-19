import type { LessonEvidence, QuizQuestion } from '@/lib/types';
import type { ModuleSyllabus } from '@/lib/lms/lmsAdapter';
import { MODULES } from '@/lib/lms/sandboxData';

/* The question bank: what Lindiwe falls back on when the model is off.
 *
 * Every bank runs roughly easy → hard, so the first N questions make a fair
 * test of any length. Each module keeps a spare or two beyond ten, so the
 * Reviewer always has an on-topic replacement for a flagged question. Every
 * question names a module keyword, so the Reviewer's on-topic rubric passes. */

export const Q = (prompt: string, options: string[], answerIndex: number, explanation: string, topicTag: string): Omit<QuizQuestion, 'id'> => ({ prompt, options, answerIndex, explanation, topicTag });

export interface Bank { summary: string; keyPoints: string[]; questions: Omit<QuizQuestion, 'id'>[] }

export const QUESTION_BANK: Record<string, Bank> = {
  'JS-07': {
    summary: 'A Promise is a placeholder for a value that is not ready yet. It starts pending and settles once, as either fulfilled (with a value) or rejected (with a reason). .then() runs when it fulfils, .catch() when it rejects, and each returns a new Promise, which is what makes chaining work. async/await is the same machinery in a friendlier shape: await pauses the async function until the Promise settles, and a rejected Promise becomes a thrown error you catch with try/catch. Promise.all runs several Promises together and rejects as soon as any one of them rejects.',
    keyPoints: [
      'Pending → fulfilled or rejected. A Promise settles once and never changes again.',
      'Every .then() returns a new Promise, so the chain passes values down.',
      'await only works inside an async function; a rejected Promise throws at the await.',
      'Promise.all waits for all and fails fast; Promise.allSettled never fails.',
      'await in a loop runs one at a time; Promise.all runs them together.',
    ],
    questions: [
      Q('A Promise is created with `new Promise(() => {})` and its executor never calls resolve or reject. What state is it in?',
        ['fulfilled', 'rejected', 'pending', 'settled'],
        2, 'A Promise starts pending and only leaves that state when resolve or reject is called. Neither is called here, so it stays pending forever.', 'Promise states'),
      Q('An async function ends with `return 5`. What does calling it give you?',
        ['The number 5', 'A Promise that fulfils with 5', 'undefined', 'An error, because async functions cannot return numbers'],
        1, 'An async function always returns a Promise. The value you return becomes the fulfilled value, so you get a Promise of 5 and read it with await or .then().', 'async/await'),
      Q('What does `await` do inside an async function?',
        ['Blocks the whole browser until the Promise settles', 'Pauses that function until the Promise settles, then gives back the fulfilled value', 'Converts the Promise into a callback', 'Runs the Promise a second time'],
        1, 'await pauses only the async function it is in. The rest of the program keeps running, and when the Promise fulfils the function resumes with the value.', 'async/await'),
      Q('A fetch inside an async function rejects. Which pattern catches the error?',
        ['if (response.error) { ... }', 'response.catch(err => ...) after the await', 'try { await fetch(url) } catch (err) { ... }', 'await.catch(err => ...)'],
        2, 'With await, a rejected Promise becomes a thrown error. try/catch around the await is the way to handle it.', 'error handling'),
      Q('In `getUser().then(u => u.id).then(id => console.log(id))`, what does the second .then() receive?',
        ['The original user object', 'undefined', 'The value returned by the first .then(), the id', 'A new Promise it must await'],
        2, 'Each .then() returns a new Promise that fulfils with whatever the callback returned, so the id flows into the next step of the chain.', 'Promise chaining'),
      Q('What does `.finally()` do on a Promise chain?',
        ['Runs only if the Promise rejects', 'Runs whether the Promise fulfils or rejects, without changing the result', 'Cancels the Promise', 'Turns a rejection into a fulfilment'],
        1, '.finally() is for clean-up, like hiding a loading spinner. It runs on either outcome and passes the original result or error straight through.', 'Promise chaining'),
      Q('A callback inside `.then()` throws an error. What happens next?',
        ['The error is silently ignored', 'The Promise returned by that .then() rejects, and the next .catch() in the chain receives it', 'The whole page crashes immediately', 'The previous .then() runs again'],
        1, 'Throwing inside .then() rejects the Promise that .then() returned. The rejection travels down the chain until a .catch() (or try/catch around await) handles it.', 'error handling'),
      Q('What does `Promise.all([a, b, c])` return?',
        ['The first Promise to settle', 'A single Promise that fulfils with an array of all three values, or rejects as soon as any one rejects', 'An array of three settled values immediately', 'Nothing; it only runs them'],
        1, 'Promise.all combines them into one Promise. It fulfils with the array of results in order, and it rejects fast if any input rejects.', 'Promise.all'),
      Q('You `await` three independent fetch calls one after another and the page is slow. What makes them run at the same time?',
        ['Add another await in front of each call', 'Start all three, then `await Promise.all([p1, p2, p3])` once', 'Wrap each call in setTimeout', 'Put each await in its own try/catch'],
        1, 'Awaiting one by one waits for each before starting the next. Starting them together and awaiting Promise.all lets the requests overlap, so the total time is roughly the slowest one.', 'Promise.all'),
      Q('Which statement about `Promise.race([p1, p2])` is true?',
        ['It waits for both Promises to finish', 'It settles as soon as the first input Promise settles, whether fulfilled or rejected', 'It always fulfils', 'It runs p1 first, then p2'],
        1, 'Promise.race copies the outcome of whichever input settles first. That makes it useful for timeouts: race the request against a timer that rejects.', 'Promise.race'),
      Q('Which runs first: a resolved Promise\'s `.then()` callback or a `setTimeout(..., 0)` callback scheduled earlier?',
        ['setTimeout, because it was scheduled first with 0 ms', 'The .then() callback, because microtasks run before the next macrotask', 'They run at exactly the same time', 'It is random'],
        1, 'Promise callbacks are microtasks. The event loop drains every microtask before it takes the next macrotask, such as a timer callback.', 'event loop'),
      Q('Which log order does this produce?\n\nconsole.log("A");\nsetTimeout(() => console.log("B"), 0);\nPromise.resolve().then(() => console.log("C"));\nconsole.log("D");',
        ['A, B, C, D', 'A, D, C, B', 'A, D, B, C', 'A, C, D, B'],
        1, 'Synchronous code runs first (A, D). Then the microtask queue drains (C) before the timer callback on the macrotask queue (B).', 'event loop'),
    ],
  },
  'SQL-04': {
    summary: 'A JOIN combines rows from two tables on a matching key. INNER JOIN keeps only the rows that match on both sides. LEFT JOIN keeps every row from the left table and fills the right side with NULL where nothing matches, which is how you find "customers with no orders". GROUP BY folds many rows into one per group so you can COUNT, SUM or AVG them, and HAVING filters those groups after the aggregation (WHERE filters rows before it).',
    keyPoints: [
      'INNER JOIN: matches only. LEFT JOIN: everything on the left, NULLs where no match.',
      'Join on the foreign key; a wrong ON clause multiplies rows.',
      'WHERE filters rows before grouping; HAVING filters groups after.',
      'COUNT(column) ignores NULLs; COUNT(*) counts rows.',
    ],
    questions: [
      Q('What does an INNER JOIN return?',
        ['Every row from both tables', 'Only the rows that have a match in both tables', 'Only the rows from the left table', 'Only rows with NULL keys'],
        1, 'INNER JOIN keeps a row only when the ON condition finds a match on both sides. Unmatched rows from either table are left out.', 'INNER JOIN'),
      Q('Which part of a join tells the database how the two tables are matched?',
        ['WHERE', 'ON', 'GROUP BY', 'ORDER BY'],
        1, 'The ON clause holds the join condition, usually foreign key = primary key, for example ON orders.customer_id = customers.id.', 'join keys'),
      Q('Which query lists every customer, including those who have never placed an order?',
        ['SELECT ... FROM customers INNER JOIN orders ON ...', 'SELECT ... FROM customers LEFT JOIN orders ON customers.id = orders.customer_id', 'SELECT ... FROM orders LEFT JOIN customers ON ...', 'SELECT ... FROM customers CROSS JOIN orders'],
        1, 'LEFT JOIN keeps every row from the left table (customers) and fills order columns with NULL where there is no match.', 'LEFT JOIN'),
      Q('In a LEFT JOIN from customers to orders, what is `orders.total` for a customer with no orders?',
        ['0', 'An empty string', 'NULL', 'The row is dropped'],
        2, 'Unmatched right-side columns are NULL in a LEFT JOIN. The customer row is kept.', 'NULL handling'),
      Q('What is the difference between `COUNT(*)` and `COUNT(email)`?',
        ['There is no difference', 'COUNT(*) counts every row; COUNT(email) skips rows where email is NULL', 'COUNT(email) counts only distinct emails', 'COUNT(*) skips NULL rows'],
        1, 'COUNT(*) counts rows. COUNT(column) counts only the rows where that column is not NULL, which matters after a LEFT JOIN.', 'aggregates'),
      Q('What does `SELECT region, SUM(total) FROM sales GROUP BY region` return?',
        ['One row per sale', 'One row per region, with that region\'s total', 'Only the grand total', 'An error, because SUM needs HAVING'],
        1, 'GROUP BY folds the rows into one group per region, and SUM adds up total inside each group.', 'GROUP BY'),
      Q('After `GROUP BY customer_id`, which clause keeps only customers with more than 5 orders?',
        ['WHERE COUNT(*) > 5', 'HAVING COUNT(*) > 5', 'ORDER BY COUNT(*) > 5', 'LIMIT 5'],
        1, 'HAVING filters groups after aggregation. WHERE runs before grouping, so it cannot see COUNT(*).', 'HAVING'),
      Q('customers has 100 rows, orders has 250 rows and every order belongs to a customer. How many rows does `customers INNER JOIN orders` return?',
        ['100', '250', '350', '25,000'],
        1, 'Each order matches exactly one customer, so the inner join returns one row per order: 250.', 'INNER JOIN'),
      Q('Why does `SELECT name, COUNT(*) FROM students` fail in most databases?',
        ['COUNT(*) is not allowed on a table', 'name is neither aggregated nor listed in a GROUP BY', 'students must be joined to another table first', 'COUNT needs a WHERE clause'],
        1, 'Once you aggregate, every selected column must either be aggregated or appear in GROUP BY. Add GROUP BY name, or remove name.', 'GROUP BY'),
      Q('Which query finds customers who have never placed an order?',
        ['... INNER JOIN orders ON ... WHERE orders.id IS NULL', '... LEFT JOIN orders ON customers.id = orders.customer_id WHERE orders.id IS NULL', '... LEFT JOIN orders ON ... WHERE orders.id = 0', '... CROSS JOIN orders'],
        1, 'LEFT JOIN keeps customers without orders and gives them NULL order columns; WHERE orders.id IS NULL then keeps exactly those customers.', 'LEFT JOIN'),
      Q('You join two tables and the row count explodes far past either table. What most likely happened?',
        ['The ON condition matched many rows to many rows, multiplying the results', 'The database ran out of memory', 'LEFT JOIN removed rows', 'GROUP BY was missing'],
        0, 'If the join key is not unique on either side, every match pairs up with every other match. Check the ON clause uses the right key.', 'join keys'),
      Q('You need the average order total per customer, only for customers averaging over R500. Which is right?',
        ['WHERE AVG(total) > 500 GROUP BY customer_id', 'GROUP BY customer_id HAVING AVG(total) > 500', 'HAVING customer_id > 500', 'ORDER BY AVG(total) > 500'],
        1, 'Group first, then filter the groups with HAVING on the aggregate. WHERE cannot use AVG.', 'HAVING'),
    ],
  },
  'RE-03': {
    summary: 'State is the data a component owns and that can change over time. useState gives you the value and a setter; calling the setter re-renders the component with the new value. Never mutate state directly: create a new object or array so React sees the change. useEffect runs side effects after render, and its dependency array decides when: [] once on mount, [x] whenever x changes, and no array after every render.',
    keyPoints: [
      'Calling the setter schedules a re-render; mutating state does not.',
      'Copy, then change: setItems([...items, newItem]), not items.push().',
      'useEffect dependencies list every value the effect reads.',
      'Share state by lifting it to the closest common parent.',
    ],
    questions: [
      Q('What does `const [count, setCount] = useState(0)` give you?',
        ['Two variables that both hold 0', 'The current value and a function that updates it', 'A global variable', 'A reference to a DOM node'],
        1, 'useState returns a pair: the current state value and the setter. Calling setCount with a new value re-renders the component.', 'useState'),
      Q('When does a React component re-render?',
        ['Only when the page reloads', 'When its state or its props change', 'Every second, automatically', 'Only when useEffect runs'],
        1, 'A new state value from a setter, or new props from the parent, makes React render the component again.', 're-render'),
      Q('What does `useEffect(() => { fetchData(); }, [])` do?',
        ['Runs fetchData on every render', 'Runs fetchData once, after the first render', 'Never runs fetchData', 'Runs fetchData before the component mounts'],
        1, 'An empty dependency array means the effect has no dependencies, so it runs once after the component mounts.', 'useEffect'),
      Q('What does a `useEffect` with no dependency array at all do?',
        ['Runs once', 'Runs after every render', 'Never runs', 'Runs only when the component unmounts'],
        1, 'Without a dependency array the effect runs after every render, which is rarely what you want for fetching data.', 'useEffect'),
      Q('Why does `items.push(newItem); setItems(items);` fail to show the new item?',
        ['push is asynchronous', 'The array reference did not change, so React skips the re-render', 'setItems only accepts strings', 'useState cannot hold arrays'],
        1, 'React compares the new state to the old by reference. The same array object means "nothing changed". Create a new array: setItems([...items, newItem]).', 'immutable updates'),
      Q('Which is the correct way to change one field of an object held in state?',
        ["user.name = 'Thando'; setUser(user);", "setUser({ ...user, name: 'Thando' })", "setUser.name('Thando')", "user.setName('Thando')"],
        1, 'Spread the old object into a new one and override the field. A new object means React sees the state change and re-renders.', 'immutable updates'),
      Q('What happens when you call `setCount(count + 1)` three times in one click handler?',
        ['count increases by 3', 'count increases by 1, because each call read the same stale count', 'React throws an error', 'The component unmounts'],
        1, 'All three calls read the same count from this render. Use the updater form, setCount(c => c + 1), to build on the latest value.', 'useState'),
      Q('Two sibling components need the same piece of state. Where should it live?',
        ['In whichever sibling renders first', 'In a global variable outside React', 'In their closest common parent, passed down as props', 'Duplicated in both and kept in sync manually'],
        2, 'Lift the state up to the closest common parent and pass the value and setter down as props.', 'lifting state'),
      Q('A child component must change state that lives in its parent. What do you do?',
        ['Change the parent\'s state variable directly from the child', 'Pass the setter, or a handler that calls it, down as a prop and call it from the child', 'Use a global variable', 'Copy the state into the child and edit the copy'],
        1, 'State is changed only by its owner. Passing a handler down as a prop lets the child ask the parent to update its state.', 'lifting state'),
      Q('An effect reads `userId`, but its dependency array is `[]`. What goes wrong?',
        ['Nothing at all', 'The effect keeps using the first userId and never re-runs when userId changes', 'React refuses to compile', 'The effect runs twice as often'],
        1, 'The dependency array tells React when to re-run the effect. Leaving userId out means the effect is stuck with a stale value; list every value it reads.', 'dependency array'),
      Q('What is the clean-up function returned from a `useEffect` for?',
        ['Deleting the component\'s state', 'Undoing the effect, for example clearing a timer or unsubscribing, before it re-runs or the component unmounts', 'Resetting the props', 'Making the render faster'],
        1, 'Return a function from the effect and React calls it before the effect runs again and when the component unmounts, so timers and subscriptions do not leak.', 'useEffect'),
      Q('You keep `firstName`, `lastName` and `fullName` all in state. Why is that a problem?',
        ['It is not a problem', 'fullName can drift out of sync; derive it during render from firstName and lastName instead', 'State can only hold numbers', 'It always causes an infinite loop'],
        1, 'Anything you can calculate from existing state or props should be derived during render, not stored, so there is one source of truth.', 'derived state'),
    ],
  },
  'CSS-04': {
    summary: 'Flexbox lays items out in one direction. Put display: flex on the container, not the items. The main axis follows flex-direction (a row by default): justify-content spreads items along it and align-items lines them up across it. flex-wrap lets items move onto a new line, and gap spaces them without margins. Grid lays things out in two dimensions: grid-template-columns and grid-template-rows define the tracks, the fr unit shares the free space, grid-template-areas names regions of the page, and items can span several tracks. Reach for flexbox for a row or column of things, and grid for the page layout.',
    keyPoints: [
      'display: flex goes on the container, not on the items.',
      'justify-content works along the main axis; align-items across it.',
      'flex-direction: column swaps the axes.',
      'grid-template-columns: repeat(3, 1fr) makes three equal columns.',
      'gap spaces flex and grid items without margins.',
    ],
    questions: [
      Q('Where do you put `display: flex` to lay out three buttons in a row?',
        ['On each button', 'On the container that holds the buttons', 'On the body element only', 'On the first button'],
        1, 'Flexbox is switched on for the container. Its direct children then become flex items laid out along the main axis.', 'flex container'),
      Q('In a flex container with the default `flex-direction: row`, which property centres the items horizontally?',
        ['align-items: center', 'justify-content: center', 'text-align: center', 'vertical-align: middle'],
        1, 'In a row the main axis is horizontal, and justify-content distributes items along the main axis.', 'justify-content'),
      Q('Which property centres items vertically in a default (row) flex container?',
        ['justify-content: center', 'align-items: center', 'flex-wrap: wrap', 'grid-area: center'],
        1, 'align-items works on the cross axis. In a row the cross axis is vertical, so align-items: center centres the items vertically.', 'align-items'),
      Q('Which property adds equal space between flex or grid items without using margins?',
        ['padding', 'gap', 'spacing', 'border-spacing'],
        1, 'gap sets the space between items in both flexbox and grid layouts, and never adds space at the outer edges.', 'gap'),
      Q('What changes when you set `flex-direction: column` on a flex container?',
        ['Nothing visible', 'The main axis becomes vertical, so justify-content now works top to bottom', 'The items become a grid', 'The items wrap automatically'],
        1, 'flex-direction sets the main axis. In a column, justify-content works vertically and align-items works horizontally.', 'flex-direction'),
      Q('Flex items overflow a narrow phone screen on a single line. Which property lets them move to a new line?',
        ['flex-wrap: wrap', 'align-items: wrap', 'justify-content: wrap', 'display: block'],
        0, 'By default flex items stay on one line and shrink. flex-wrap: wrap lets them flow onto new lines when there is not enough room.', 'flex-wrap'),
      Q('What does `grid-template-columns: repeat(3, 1fr)` create?',
        ['Three rows', 'Three equal-width columns that share the free space', 'One column 3px wide', 'Three columns each 1px wide'],
        1, 'repeat(3, 1fr) defines three grid column tracks, and fr shares the available space between them, so they are equal.', 'grid tracks'),
      Q('What does `flex: 1` on every item in a flex row do?',
        ['Makes each item 1px wide', 'Lets the items grow to share the free space equally', 'Hides the items', 'Stacks the items vertically'],
        1, 'flex: 1 lets each flex item grow from the same basis, so the free space in the row is shared equally.', 'flex items'),
      Q('In `justify-content: space-between`, where does the free space go?',
        ['Only at the two ends', 'Equally between the items, with none at the outer edges', 'Equally around every item, edges included', 'Nowhere; the items stretch'],
        1, 'space-between pushes the first and last flex items to the edges and shares the rest of the space evenly between items.', 'justify-content'),
      Q('How do you make a grid item span two columns?',
        ['grid-column: span 2', 'column-span: 2', 'flex: 2', 'grid-row: 2'],
        0, 'grid-column: span 2 tells the grid item to stretch across two column tracks from where it is placed.', 'grid placement'),
      Q('You need a page layout with a header, sidebar, main area and footer. Which tool fits best?',
        ['Flexbox with floats', 'CSS Grid with grid-template-areas', 'Absolute positioning for every box', 'An HTML table'],
        1, 'Grid handles two dimensions at once, and grid-template-areas lets you name and arrange the regions of the layout clearly.', 'grid template areas'),
      Q('When should you reach for flexbox instead of grid?',
        ['Never; grid replaces flexbox', 'When laying out items in one direction, like a row of buttons or a nav bar', 'Only for images', 'When you need a two-dimensional page layout'],
        1, 'Flexbox is one-dimensional and great for rows or columns of things. Grid is for two-dimensional layout.', 'flexbox vs grid'),
    ],
  },
  'PY-05': {
    summary: 'pandas holds tables in a DataFrame: labelled rows and columns, where each column is a Series. Select a column with df["col"], filter rows with a boolean mask such as df[df["score"] < 50], and handle missing values with isna(), fillna() or dropna(). groupby splits the rows into groups, applies an aggregate such as mean() or sum(), and combines the results. merge joins two DataFrames on a key, just like SQL: how="inner" keeps matches only and how="left" keeps every left row. Most pandas operations return a new DataFrame rather than changing the original, so assign the result.',
    keyPoints: [
      'A DataFrame is a table; each column is a Series.',
      'Filter with a boolean mask: df[df["score"] < 50].',
      'groupby("col")["x"].mean() means split, apply, combine.',
      'merge(left, right, on="id", how="left") works like a SQL LEFT JOIN.',
      'Most pandas methods return a new DataFrame: assign the result.',
    ],
    questions: [
      Q('What is a pandas DataFrame?',
        ['A Python list of numbers', 'A table of labelled rows and columns', 'A chart', 'A database connection'],
        1, 'A DataFrame is pandas\' table: rows and columns with labels. Each column is a Series.', 'DataFrame basics'),
      Q('How do you select the "score" column from a DataFrame called df?',
        ['df.score()', 'df["score"]', 'df.get_column(score)', 'select score from df'],
        1, 'Square brackets with the column name return that column of the DataFrame as a Series.', 'DataFrame selection'),
      Q('Which expression keeps only the rows of DataFrame df where score is below 50?',
        ['df.filter(score < 50)', 'df[df["score"] < 50]', 'df.where("score" < 50)', 'df["score" < 50]'],
        1, 'df["score"] < 50 builds a True/False mask, and df[mask] keeps the rows where the mask is True.', 'pandas boolean filtering'),
      Q('How do you fill missing scores with 0 in the "score" column of a DataFrame?',
        ['df["score"] = df["score"].fillna(0)', 'df["score"].replace(None)', 'df.fill(0)', 'df["score"] = NaN'],
        0, 'fillna returns a new Series with the gaps filled; assigning it back updates the DataFrame column.', 'pandas missing values'),
      Q('`df.dropna()` is called, but df still has missing values afterwards. Why?',
        ['dropna does not exist in pandas', 'dropna returns a new DataFrame, and the result was never assigned back', 'dropna only works on numbers', 'Missing values can never be removed'],
        1, 'Most pandas methods return a new DataFrame. Write df = df.dropna() to keep the result.', 'pandas missing values'),
      Q('What does `df.groupby("cohort")["score"].mean()` return?',
        ['The overall mean score', 'The mean score for each cohort', 'The number of cohorts', 'A sorted DataFrame'],
        1, 'groupby splits the rows by cohort, mean() is applied to score inside each group, and the results are combined: one mean per cohort.', 'groupby'),
      Q('Which pandas call counts how many rows are in each cohort?',
        ['df.groupby("cohort").size()', 'df.count_groups("cohort")', 'df.groupby().len', 'df.merge("cohort")'],
        0, 'groupby("cohort").size() returns the number of rows in each group.', 'groupby'),
      Q('What does `pd.merge(students, payments, on="student_id", how="inner")` keep?',
        ['Every student', 'Every payment', 'Only the student_id values found in both DataFrames', 'Nothing until you call .run()'],
        2, 'An inner merge keeps only keys present in both DataFrames, just like a SQL INNER JOIN.', 'merge'),
      Q('You merge with `how="left"`. What happens to a student with no payments?',
        ['The student is dropped', 'The student is kept, with NaN in the payment columns', 'pandas raises an error', 'The payment columns are filled with 0'],
        1, 'A left merge keeps every row of the left DataFrame and fills the right-hand columns with NaN where nothing matched.', 'merge'),
      Q('What does `df.groupby("cohort").agg({"score": "mean", "id": "count"})` produce?',
        ['One row per student', 'One row per cohort, with the mean score and the number of students', 'A merged DataFrame', 'An error, because agg takes one function only'],
        1, 'agg applies a different aggregate to each column inside every group: here the mean of score and the count of id per cohort.', 'groupby aggregation'),
      Q('After a merge, the result has more rows than either input DataFrame. What is the most likely cause?',
        ['The key is duplicated on both sides, so the matches multiply', 'merge always duplicates rows', 'You used how="inner"', 'The DataFrames were sorted'],
        0, 'When a key appears several times on both sides, merge pairs every match with every other match. Check the key is unique where you expect it to be.', 'merge'),
    ],
  },
  'SEC-06': {
    summary: 'A firewall decides which network traffic may come in or go out, using rules about the source, destination, port and protocol. The safe default is to deny everything and then allow only what is needed. Ports identify services: 22 for SSH, 53 for DNS, 80 for HTTP and 443 for HTTPS. TLS encrypts traffic between a client and a server, protects it from being changed, and proves the server\'s identity with a certificate signed by a trusted authority. Threat modelling asks four questions before you build: what are we building, what can go wrong, what will we do about it, and did we do a good job.',
    keyPoints: [
      'Firewall default: deny everything, allow only what is needed.',
      'Common ports: 22 SSH, 53 DNS, 80 HTTP, 443 HTTPS.',
      'TLS gives encryption, integrity and server identity via certificates.',
      'Threat modelling: assets, threats, mitigations, then review.',
      'Least privilege: open the fewest ports to the fewest sources.',
    ],
    questions: [
      Q('What is the main job of a firewall?',
        ['Speeding up the network', 'Allowing or blocking traffic based on rules', 'Encrypting files on disk', 'Backing up servers'],
        1, 'A firewall filters network traffic. Each rule allows or blocks traffic by source, destination, port and protocol.', 'firewall basics'),
      Q('Which port does HTTPS use by default?',
        ['21', '22', '80', '443'],
        3, 'HTTPS, which is HTTP over TLS, listens on port 443 by default. Plain HTTP uses port 80.', 'ports'),
      Q('Which port does SSH (remote login) use by default?',
        ['22', '25', '53', '3389'],
        0, 'SSH listens on port 22. Port 25 is SMTP, 53 is DNS and 3389 is Windows Remote Desktop.', 'ports'),
      Q('What does TLS provide for a website connection?',
        ['Faster page loads', 'Encryption, integrity and proof of the server\'s identity', 'A firewall', 'Free hosting'],
        1, 'TLS encrypts the traffic, detects tampering, and uses the server\'s certificate to prove you are talking to the real site.', 'TLS'),
      Q('What is the safest default policy for inbound traffic on a firewall?',
        ['Allow everything and block known bad addresses', 'Deny everything, then allow only the ports and sources you need', 'Allow only port 80', 'Turn the firewall off during working hours'],
        1, 'Default deny means anything you did not deliberately allow is blocked, which keeps the attack surface small.', 'firewall policy'),
      Q('A browser warns that a site\'s TLS certificate is not trusted. What does that most likely mean?',
        ['The site is very fast', 'The certificate is expired, does not match the domain, or was not signed by a trusted authority', 'The firewall is switched off', 'Port 443 is closed'],
        1, 'TLS trust depends on a valid certificate for that exact domain, signed by an authority the browser trusts. Any of those failing triggers the warning.', 'TLS certificates'),
      Q('Your web server only needs to serve HTTPS. Which inbound firewall rules make sense?',
        ['Allow all ports from anywhere', 'Allow port 443 from anywhere, and SSH (22) only from the admin network', 'Allow port 22 from anywhere', 'Block port 443'],
        1, 'Open only what the service needs (443) to the public, and restrict admin access (22) to trusted sources.', 'firewall rules'),
      Q('In threat modelling, what do you ask first?',
        ['Which antivirus should we buy?', 'What are we building, and what is worth protecting?', 'Who should we blame?', 'Which port is fastest?'],
        1, 'Threat modelling starts by understanding the system and its valuable assets; only then can you list what could go wrong.', 'threat modelling'),
      Q('Which threat does TLS protect against?',
        ['A stolen laptop', 'Someone on the same Wi-Fi reading or changing your traffic (a man-in-the-middle)', 'A weak password', 'A full hard drive'],
        1, 'TLS protects data in transit. It cannot protect a stolen device or a weak password.', 'TLS'),
      Q('Why is leaving a database port such as 5432 open to the whole internet a threat?',
        ['It slows the database down', 'Anyone can try to connect and brute-force or exploit it; a firewall should limit it to the app servers', 'Databases do not use ports', 'It is fine if the password is long'],
        1, 'Every open port is a way in. Database ports should only accept connections from the servers that need them.', 'attack surface'),
      Q('Which principle should decide which ports a firewall opens?',
        ['Whatever is most convenient', 'Least privilege: the fewest ports, to the fewest sources', 'Open everything while testing, then forget', 'Change the port numbers every day'],
        1, 'Least privilege keeps the attack surface as small as possible: each open port should have a reason and a limited audience.', 'least privilege'),
    ],
  },
};

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'your', 'that', 'this', 'what', 'when', 'how', 'why', 'module', 'unit', 'course', 'part', 'intro', 'introduction', 'basics', 'fundamentals', 'week', 'lesson']);

/** The syllabus for a module code, or a stand-in built from its title and the
 *  weak topic when the module is not one we know (a real Moodle course). */
export function syllabusFor(code: string | null | undefined, title?: string | null, topic?: string | null): ModuleSyllabus {
  const known = MODULES.find((m) => m.code === code);
  if (known) return known;
  const words = `${title || ''} ${topic || ''}`.toLowerCase().replace(/[^a-z0-9+#.\s/-]/g, ' ').split(/[\s/]+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const phrase = (topic || '').toLowerCase().trim();
  const keywords = Array.from(new Set([...(phrase ? [phrase] : []), ...words])).slice(0, 14);
  return {
    code: code || 'MOD',
    title: title || topic || 'Current module',
    programmeCode: 'GEN',
    topics: [topic, title].filter((x): x is string => Boolean(x && x.trim())),
    keywords: keywords.length ? keywords : ['study'],
  };
}

/** A fair, module-agnostic bank for a course we have no questions for and no model to ask. */
function genericBank(mod: ModuleSyllabus, topic: string): Bank {
  const t = topic || mod.title;
  return {
    summary: `${t} is the part of ${mod.title} to focus on now. Go back to the definition first, then work through one small example slowly, saying out loud what each step does and why. Compare a correct example with a common mistake, and write down the difference in your own words. Finally, try one problem on your own before looking at the answer, and note anything that still feels unclear so you can ask your facilitator.`,
    keyPoints: [
      `Start from the definition of ${t} in your own words.`,
      'Work one small example step by step, explaining each step.',
      'Compare a correct example with a common mistake.',
      'Try one problem alone before checking the answer.',
    ],
    questions: [
      Q(`You feel stuck on ${t}. What is the most useful first step?`,
        ['Skip it and hope it comes up less', `Re-read the definition of ${t} and explain it in your own words`, 'Memorise the answers to last week\'s quiz', 'Wait for the exam'],
        1, `Understanding starts with the definition. Explaining ${t} in your own words shows you exactly which part is unclear.`, t),
      Q(`What is the best way to check you really understand ${t}?`,
        ['Read the notes again three times', `Solve a fresh ${t} problem on your own before looking at the answer`, 'Highlight the textbook', 'Watch a video at double speed'],
        1, 'Retrieval practice, solving without help first, is the strongest signal of real understanding.', t),
      Q(`You keep making the same mistake on ${t}. What should you do?`,
        ['Ignore it', `Compare your answer with a correct ${t} example and write down the difference`, 'Change topics', 'Copy a classmate\'s answer'],
        1, 'Putting a mistake next to a correct example makes the misconception visible, so you can fix it.', t),
      Q(`Which habit helps ${t} stick for the next assessment?`,
        ['Cramming the night before', `Short practice on ${t} spread over several days`, 'Studying only the parts you already know', 'Reading without trying any problems'],
        1, 'Spaced practice over several days beats one long cram session for long-term memory.', t),
      Q(`You have tried ${t} on your own and still have a question. What next?`,
        ['Give up on the topic', 'Write the exact question down and ask your facilitator or study group', 'Guess on the test', 'Wait until the next module'],
        1, 'A specific written question gets a specific, fast answer from your facilitator or peers.', t),
    ],
  };
}

/** The bank for a module: its own questions, or a generic one built from the topic. */
export function bankFor(mod: ModuleSyllabus, topic: string): Bank {
  return QUESTION_BANK[mod.code] || genericBank(mod, topic);
}

/** One phrase: what the tutor noticed that made this lesson necessary. */
export function noticedLine(evidence: LessonEvidence | null | undefined, mod: ModuleSyllabus, topic: string): string {
  const e = evidence || {};
  const what = e.assessmentTitle?.trim() || `the ${mod.code} checkpoint`;
  const missed = (e.missedTopics || []).filter(Boolean).slice(0, 2);
  if (typeof e.scorePct === 'number') {
    const tail = missed.length ? `the questions on ${missed.join(' and ')} tripped you up` : `${topic} was the part that tripped you up`;
    return `you scored ${Math.round(e.scorePct)}% on ${what}, and ${tail}`;
  }
  if (typeof e.daysSinceLogin === 'number' && e.daysSinceLogin >= 5) {
    return `you have not been in ${mod.code} for ${e.daysSinceLogin} days, and ${topic} is where things got stuck`;
  }
  return `${topic} is the one thing holding you back in ${mod.code}`;
}

const clampInt = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt;
  return Math.max(lo, Math.min(hi, v));
};
/** Mastery test length: 3 to 15 questions, 10 by default. */
export const clampQuestions = (n: unknown) => clampInt(n, 3, 15, 10);
/** Pass mark: 30% to 100%, 70% by default. */
export const clampPassMark = (n: unknown) => clampInt(n, 30, 100, 70);
