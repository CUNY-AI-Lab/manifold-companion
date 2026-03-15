function Box({ className = '' }) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

function Circle({ className = '' }) {
  return <div className={`animate-pulse bg-gray-200 rounded-full ${className}`} />;
}

function Card() {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6">
      <Box className="h-5 w-3/4 mb-3" />
      <Box className="h-3 w-full mb-2" />
      <Box className="h-3 w-2/3 mb-4" />
      <div className="flex gap-2">
        <Box className="h-5 w-20 rounded-full" />
        <Box className="h-5 w-16 rounded-full" />
        <Box className="h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}

function TextRow() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4">
      <Box className="h-10 w-10 rounded-lg flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <Box className="h-4 w-1/3 mb-2" />
        <Box className="h-3 w-1/2" />
      </div>
      <Box className="h-5 w-16 rounded-full flex-shrink-0" />
    </div>
  );
}

function TableRow({ cols = 5 }) {
  return (
    <tr>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="px-4 py-3">
          <Box className={`h-4 ${i === 0 ? 'w-40' : i === cols - 1 ? 'w-20' : 'w-24'}`} />
        </td>
      ))}
    </tr>
  );
}

const Skeleton = { Box, Circle, Card, TextRow, TableRow };
export default Skeleton;
